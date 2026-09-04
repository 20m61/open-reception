/**
 * `scripts/url-quality-gate.sh` の振る舞い検証。
 *
 * `tests/hooks/aws-cloud-deploy.test.ts` と同じ方針: 実際に起動して確かめる。
 * **外部ネットワークへは出ない** —— 到達不能な `127.0.0.1:1`（接続拒否）を対象にする。
 *
 * 🔴 **docker / Chrome の有無をホスト環境に委ねない。** 開発者の Mac では docker が
 * 動いていて、クラウドでは動いていない。環境で結果が変わるテストは、どちらかの環境で
 * 必ず嘘をつく。`PATH` を差し替えて**観測そのものを固定**する。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/url-quality-gate.sh');
/** 接続拒否になるアドレス。DNS も外部ネットワークも使わない。 */
const UNREACHABLE = 'http://127.0.0.1:1';
const TIMEOUT = 120_000;

/** node / npx は要るので、それらのディレクトリだけを残した PATH を組む。 */
function pathWithoutDocker(extraDir?: string): string {
  const kept = (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir.length > 0 && !dir.includes('docker'));
  const nodeDir = resolve(process.execPath, '..');
  return [extraDir, nodeDir, ...kept].filter(Boolean).join(':');
}

/**
 * `docker` を名乗るが `info` が必ず失敗する偽物を置く。
 * クラウドサンドボックスの実態（CLI はあるがデーモンが落ちている）を再現する。
 */
function fakeDockerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'urlgate-docker-'));
  const bin = join(dir, 'docker');
  // info も run も非ゼロ。run は exit 1 —— zap-baseline.py の「高リスク検出」と同じコード。
  writeFileSync(bin, '#!/bin/sh\necho "daemon down" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  return dir;
}

function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: {
      ...process.env,
      // lhci は重いので既定で切る。lighthouse 自体の検証は plan 側（純関数）が持つ。
      ...env,
    },
  });
}

describe('url-quality-gate.sh', () => {
  describe('smoke の HTTP コード表示', () => {
    /**
     * 🔴 **回帰: `000000` を出さない。**
     *
     * 旧実装は `curl ... || echo 000` と書いていた。curl は接続失敗時にも
     * `-w '%{http_code}'` で `000` を出力し、**かつ非ゼロで終了する**ので、`||` の
     * `echo 000` が連結されて `000000` になっていた（実測・長さ 6）。
     * HTTP コードとして読めない値が運用者に出る。
     *
     * このテストは `|| echo 000` を戻す変異で落ちる。
     */
    it('接続不成立でも 000 を 1 つだけ出す（000000 にしない）', () => {
      const { stdout } = run([UNREACHABLE, '--no-zap', '--no-lighthouse']);
      expect(stdout).toMatch(/HTTP 000$/m);
      expect(stdout).not.toContain('000000');
    }, TIMEOUT);

    /**
     * **下界も縛る。** 「000000 を出さない」だけなら、smoke 節を丸ごと消しても通る。
     * 主要 3 ルートを実際に見に行っていることまで要求する。
     */
    it('主要 3 ルートすべてを報告し、接続不成立として FAIL する', () => {
      const { stdout, status } = run([UNREACHABLE, '--no-zap', '--no-lighthouse']);
      for (const p of ['/', '/kiosk', '/admin/login']) {
        expect(stdout).toContain(p);
      }
      expect(stdout).toContain('接続不成立');
      expect(status).toBe(1);
    }, TIMEOUT);
  });

  describe('任意ツールの SKIP 規約', () => {
    it('docker が無ければ ZAP は SKIP で、high-risk とは言わない', () => {
      const { stdout } = run([UNREACHABLE, '--no-lighthouse'], {
        PATH: pathWithoutDocker(),
      });
      expect(stdout).toContain('ZAP: SKIP');
      expect(stdout).not.toContain('high-risk');
    }, TIMEOUT);

    /**
     * 🔴 **これが直している誤ラベルの本体。**
     *
     * docker CLI はあるがデーモンが落ちている環境では `docker run` が exit 1 を返す。
     * 旧実装は `[[ "$rc" == 1 ]] && FAILED+=("zap(high-risk)")` と終了コードだけを見て
     * いたため、**インフラ障害をセキュリティ指摘として報告**していた。
     *
     * このテストは、その終了コード判定を戻す変異で落ちる。
     */
    it('docker デーモンが落ちているだけのとき high-risk と報告しない', () => {
      const { stdout } = run([UNREACHABLE, '--no-lighthouse'], {
        PATH: pathWithoutDocker(fakeDockerDir()),
      });
      expect(stdout).not.toContain('high-risk');
      expect(stdout).toMatch(/ZAP: (SKIP|実行できませんでした)/);
    }, TIMEOUT);

    /**
     * SKIP が RESULT 行に必ず現れること。#640（45 件 SKIP のまま green 記録）と
     * 同じ誤読を防ぐ ―― 「落ちなかった」を「通った」と読ませない。
     */
    it('SKIP があれば RESULT 行に併記される', () => {
      const { stdout } = run([UNREACHABLE, '--no-lighthouse'], {
        PATH: pathWithoutDocker(),
      });
      expect(stdout).toMatch(/RESULT: .*SKIP: .*zap/);
    }, TIMEOUT);

    it('--strict では未導入が SKIP ではなく FAIL になる', () => {
      const { stdout, status } = run([UNREACHABLE, '--no-lighthouse', '--strict'], {
        PATH: pathWithoutDocker(),
      });
      expect(stdout).toContain('ZAP: FAIL');
      expect(stdout).not.toContain('ZAP: SKIP');
      expect(status).toBe(1);
    }, TIMEOUT);
  });

  it('BASE_URL が無ければ usage を出して exit 2', () => {
    const { status, stderr } = run([]);
    expect(status).toBe(2);
    expect(stderr).toContain('Usage:');
  }, TIMEOUT);
});
