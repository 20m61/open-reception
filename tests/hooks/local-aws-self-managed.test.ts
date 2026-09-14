/**
 * 自前管理（`LOCAL_AWS_CONTAINER_MODE=self`）のときのコンテナ操作を、偽の
 * `docker` / `curl` / `lstk` で検証する（#1103 AC1）。
 *
 * ## なぜ自前管理が要るか（2026-09-14 に実測）
 *
 * TLS を終端する loopback proxy 越しの環境（Claude Code on the web）では、
 * LocalStack コンテナが起動時のライセンス有効化で
 * `https://api.localstack.cloud/v1` に届かず **exit 55** で落ちる。proxy は
 * **127.0.0.1 にしか bind していない**ので bridge のコンテナからは届かず、
 * `lstk` の config は `network` を持たないため lstk 管理のままでは host
 * ネットワークにできない。`--network host` ＋ CA 持ち込みなら通る（実測）。
 *
 * ## reset について
 *
 * `lstk reset` は LocalStack の state-reset エンドポイントを叩くが、freemium の
 * 有効化では **404** が返る（実測）。自前管理のコンテナにとって確実な reset は
 * **作り直し**であり、それは `local-aws-development.md` の
 * 「emulator を reset して共有状態を持ち越さない」とも一致する。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const SCRIPT = join(ROOT, 'scripts/local-aws.sh');
const TIMEOUT = 60_000;

function writeExe(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

/**
 * 偽 docker は呼ばれたサブコマンドを記録する。
 *
 * 🔴 **状態を持たせる。** `inspect` が常に "true" を返す偽物にすると、`rm -f` のあとも
 * 「動いている」ことになり、**作り直しをしない実装でもテストが通ってしまう**
 * （実際に一度そう書いて、実装側の正しさを測れていなかった）。実物と同じく
 * 「`run` で在る／`rm -f` で無くなる」を marker ファイルで模す。
 */
function fakeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'local-aws-self-'));
  const dockerLog = join(dir, 'docker.log');
  const lstkLog = join(dir, 'lstk.log');
  const exists = join(dir, 'container-exists');

  // 初期状態: コンテナは在って動いている。
  writeFileSync(exists, '');

  writeExe(
    dir,
    'docker',
    `printf '%s\\n' "$*" >> "${dockerLog}"\n` +
      `case "$1" in\n` +
      `  info) exit 0 ;;\n` +
      `  inspect) [ -f "${exists}" ] && { printf 'true\\n'; exit 0; } || exit 1 ;;\n` +
      `  rm) rm -f "${exists}"; exit 0 ;;\n` +
      `  run) touch "${exists}"; printf 'fake-container-id\\n'; exit 0 ;;\n` +
      `esac\nexit 0`,
  );
  writeExe(dir, 'dockerd', 'exit 0');
  // health は常に成功（起動待ちループを回さない）。
  writeExe(dir, 'curl', 'exit 0');
  writeExe(
    dir,
    'lstk',
    `printf '%s\\n' "$*" >> "${lstkLog}"\n` +
      `case "$*" in *describe-time-to-live*) printf 'ENABLED\\n' ;; esac\nexit 0`,
  );
  writeExe(dir, 'npm', 'exit 0');

  return { dir, dockerLog, lstkLog };
}

function run(dir: string, subcommand: string) {
  return spawnSync('bash', [SCRIPT, subcommand], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      LOCAL_AWS_CONTAINER_MODE: 'self',
    },
  });
}

const readLog = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('local-aws.sh の自前管理コンテナ', () => {
  it(
    'self モードでは lstk にコンテナを起こさせない',
    () => {
      const { dir, lstkLog } = fakeEnv();
      const result = run(dir, 'up');

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      // lstk は data plane（aws ...）にしか使わない。
      const lstkCalls = readLog(lstkLog)
        .split('\n')
        .filter((l) => l.trim() !== '');
      expect(lstkCalls.length, 'lstk が 1 度も呼ばれていない').toBeGreaterThan(0);
      for (const call of lstkCalls) {
        expect(call, `self モードで lstk がライフサイクルを触っている: ${call}`).not.toMatch(
          /(^|\s)(start|stop)(\s|$)/,
        );
      }
    },
    TIMEOUT,
  );

  it(
    '🔴 reset は作り直しで行う（freemium では state-reset が 404 のため）',
    () => {
      const { dir, dockerLog, lstkLog } = fakeEnv();
      const result = run(dir, 'reset');

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

      // 上界: コンテナを作り直していること。
      const dockerCalls = readLog(dockerLog);
      expect(dockerCalls).toContain('rm -f');
      expect(dockerCalls).toMatch(/(^|\n)run /);

      // 🔴 下界: 使えないと分かっている経路を叩いていないこと。
      expect(readLog(lstkLog), 'self モードで lstk reset を叩いている').not.toContain('reset');
    },
    TIMEOUT,
  );

  it(
    'down はコンテナを消す',
    () => {
      const { dir, dockerLog } = fakeEnv();
      const result = run(dir, 'down');

      expect(result.status).toBe(0);
      expect(readLog(dockerLog)).toContain('rm -f');
    },
    TIMEOUT,
  );
});

/**
 * `auto` の判定そのものを縛る。
 *
 * 🔴 **これは変異検証で開いていた穴である（2026-09-14）。** 他のテストは
 * `LOCAL_AWS_CONTAINER_MODE` を明示注入していたので、`auto) echo lstk ;;` と
 * 潰す変異が**全部を素通りした**。判定を誰も見ていなかったということで、壊れても
 * 次に proxy 環境で踏むまで誰にも見えない。
 *
 * 観測点は `lane_env` の `CONTAINER_MODE` 行（preflight を通らないので前提が要らない）。
 */
describe('local-aws.sh の auto 判定', () => {
  function modeFor(env: Record<string, string | undefined>): string {
    const result = spawnSync('bash', [SCRIPT, 'env'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: {
        ...process.env,
        LOCAL_AWS_CONTAINER_MODE: 'auto',
        // 継承を断つ。呼び出し側の proxy 設定に結果が左右されないこと。
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
    });
    expect(result.status, `stderr=${result.stderr}`).toBe(0);
    const line = result.stdout.split('\n').find((l) => l.startsWith('CONTAINER_MODE='));
    expect(line, `CONTAINER_MODE が出力されていない: ${result.stdout}`).toBeDefined();
    return (line as string).slice('CONTAINER_MODE='.length).trim();
  }

  it(
    'loopback の proxy 越しなら self を選ぶ（コンテナから proxy へ届かないため）',
    () => {
      expect(modeFor({ HTTPS_PROXY: 'http://127.0.0.1:34877' })).toBe('self');
      expect(modeFor({ HTTPS_PROXY: 'http://localhost:8080' })).toBe('self');
    },
    TIMEOUT,
  );

  it(
    '🔴 proxy が無ければ lstk 管理のままにする（下界）',
    () => {
      // これが無いと「常に self」でも上のテストは通る。常に self にすると、
      // 普通の開発機で lstk の管理下を離れてしまう。
      expect(modeFor({})).toBe('lstk');
    },
    TIMEOUT,
  );

  it(
    '🔴 loopback でない proxy なら lstk のままにする（判定が「proxy の有無」で潰れていないこと）',
    () => {
      // `HTTPS_PROXY` が在るかどうかだけで決める実装を弾く。到達できる proxy なら
      // コンテナからも届くので、自前管理へ切り替える理由が無い。
      expect(modeFor({ HTTPS_PROXY: 'http://proxy.internal:3128' })).toBe('lstk');
    },
    TIMEOUT,
  );
});
