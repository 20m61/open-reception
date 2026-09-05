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
 * `docker` を名乗る偽物を置く。
 *
 * @param infoOk `docker info` が成功するか（＝デーモンが動いているように見えるか）
 *
 * 🔴 **2 層あるので 2 通り要る。** デーモン停止は plan 層（SKIP）で止まり、
 * ZAP 終了コードの解釈へ**到達しない**。`infoOk=true` の偽物だけが分類層まで届く
 * ―― 変異検証で M2（終了コードだけで判定へ戻す）が生存して分かった。
 */
function fakeDockerDir(infoOk: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'urlgate-docker-'));
  const bin = join(dir, 'docker');
  // run は必ず exit 1 —— zap-baseline.py の「高リスク検出」と同じコード。
  // レポートは書かない（＝ zap は一度も走っていない）。
  const info = infoOk ? 'exit 0' : 'echo "daemon down" >&2; exit 1';
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in\n  info) ${info} ;;\nesac\necho "docker failed" >&2\nexit 1\n`,
  );
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
        PATH: pathWithoutDocker(fakeDockerDir(false)),
      });
      expect(stdout).not.toContain('high-risk');
      expect(stdout).toMatch(/ZAP: (SKIP|実行できませんでした)/);
    }, TIMEOUT);

    /**
     * 🔴 **分類層まで到達させる試験。**
     *
     * 上の「デーモン停止」試験は plan 層の SKIP で止まるので、ZAP 終了コードの
     * 解釈を一度も通らない ―― 変異検証で「終了コードだけで判定する」へ戻す変異
     * （M2）が**生存した**ことで判明した。`CLAUDE.md`「テストの主張が落ちた先に
     * 飲み込まれていないか」そのもの。
     *
     * ここではデーモンが**動いているように見える**偽 docker を置き、`docker run` だけを
     * exit 1・レポート無しで失敗させる。plan は `run` を返すので分類層へ到達し、
     * 「レポートが無いなら high-risk とは言わない」を実際に問える。
     */
    it('docker run が exit 1 でもレポートが無ければ high-risk と報告しない', () => {
      const { stdout } = run([UNREACHABLE, '--no-lighthouse'], {
        PATH: pathWithoutDocker(fakeDockerDir(true)),
      });
      // plan 層では止まっていない（＝分類層まで来ている）ことを先に確かめる。
      expect(stdout).not.toContain('ZAP: SKIP');
      expect(stdout).toContain('実行できませんでした');
      expect(stdout).not.toContain('high-risk');
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

  describe('lighthouse の結果解釈', () => {
    /**
     * lhci だけを差し替える偽 `npx` を置く。`npx --no-install tsx ...`（判定器の呼び出し）は
     * 本物へ委譲するので、判定の配線ごと通る。
     *
     * @param writesReport lhci が outputDir に結果を書いたことにするか
     */
    function fakeNpxDir(writesReport: boolean): string {
      const dir = mkdtempSync(join(tmpdir(), 'urlgate-npx-'));
      const realNpx = spawnSync('bash', ['-lc', 'command -v npx'], {
        encoding: 'utf8',
      }).stdout.trim();
      const out = join(resolve(process.cwd()), '.url-quality-gate/lighthouse');
      const body = writesReport ? `mkdir -p "${out}"; : > "${out}/report.json"` : ':';
      writeFileSync(
        join(dir, 'npx'),
        `#!/bin/sh\ncase "$*" in\n  *@lhci/cli*) ${body}; exit 1 ;;\nesac\nexec "${realNpx}" "$@"\n`,
      );
      chmodSync(join(dir, 'npx'), 0o755);
      return dir;
    }

    /**
     * 🔴 **macOS 退行と、到達不能の両方を覆う。** lhci が結果を書けなかったなら
     * 「測れなかった」であって「閾値を割った」ではない。
     */
    it('lhci が失敗しレポートも無ければ、閾値未達とは言わず SKIP にする', () => {
      const { stdout, status } = run([UNREACHABLE, '--no-zap'], {
        PATH: `${fakeNpxDir(false)}:${process.env.PATH ?? ''}`,
      });
      expect(stdout).toContain('測れませんでした');
      expect(stdout).not.toContain('閾値未達');
      expect(stdout).toMatch(/RESULT: .*SKIP: .*lighthouse/);
      // smoke が接続不成立で FAIL するので全体は 1。lighthouse 由来の FAIL は無い。
      expect(stdout).not.toMatch(/RESULT: FAIL —[^—]*lighthouse(?!\()/);
      expect(status).toBe(1);
    }, TIMEOUT);

    /**
     * **下界も縛る。** 「常に SKIP」にする変異を止める ―― 実際に測って割ったなら FAIL。
     */
    it('lhci が失敗してレポートがあれば閾値未達として FAIL にする', () => {
      const { stdout } = run([UNREACHABLE, '--no-zap'], {
        PATH: `${fakeNpxDir(true)}:${process.env.PATH ?? ''}`,
      });
      expect(stdout).toContain('閾値未達');
      expect(stdout).not.toContain('測れませんでした');
      expect(stdout).toMatch(/RESULT: FAIL —.*lighthouse/);
    }, TIMEOUT);
  });

  it('BASE_URL が無ければ usage を出して exit 2', () => {
    const { status, stderr } = run([]);
    expect(status).toBe(2);
    expect(stderr).toContain('Usage:');
  }, TIMEOUT);
});
