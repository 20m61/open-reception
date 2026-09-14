/**
 * `scripts/local-aws.sh` が `lstk` のライフサイクル命令へ **`AWS_ENDPOINT_URL` を
 * 見せない**ことを、偽の `lstk` を使って検証する（#1103 AC1）。
 *
 * ## なぜ要るか（2026-09-14 に実測）
 *
 * `local-aws.sh` はレーン全体へ `AWS_ENDPOINT_URL` を export する。アプリと AWS CLI は
 * それを見て LocalStack を向くので、これ自体は正しい。
 *
 * ところが `lstk start` は **`AWS_ENDPOINT_URL` が設定されていると実行を拒否する**:
 *
 * ```
 * Error: start does not support AWS_ENDPOINT_URL: it operates on a local Docker
 * container or local filesystem state with no remote equivalent
 * ```
 *
 * 「自分で起こすコンテナ」を相手にする命令に、外部エンドポイントの指定は意味を持たない
 * ―― という lstk 側の主張である。結果として `npm run local:aws:up` は
 * **このリポジトリの既定設定のままでは 1 度も成功しない**状態だった。
 *
 * 🔴 **しかもエラーの出方が嘘をつく。** `start_localstack` は失敗時に
 * 「LOCALSTACK_AUTH_TOKEN を設定せよ」という助言を出すので、**実際には endpoint 変数が
 * 原因なのにトークンの問題に見える**。2026-09-14 のセッションはこれで一度誤診した。
 *
 * ## 何を縛るか
 *
 * - ライフサイクル命令（start / stop / reset）の env に `AWS_ENDPOINT_URL` が**無い**こと
 * - それでいて**レーン自体は**その値を保持していること（下界。全部消す実装を弾く）
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
 * 偽 PATH を組む。偽 `lstk` は**呼ばれたサブコマンドと、そのとき見えていた
 * `AWS_ENDPOINT_URL`** を 1 行ずつ記録する。記録が唯一の観測点。
 */
function fakeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'local-aws-lstk-'));
  const log = join(dir, 'lstk-calls.log');

  // `docker info` は常に成功（デーモン起動経路へ行かせない）。
  writeExe(dir, 'docker', 'if [ "$1" = "info" ]; then exit 0; fi\nexit 0');
  writeExe(dir, 'dockerd', 'exit 0');
  writeExe(
    dir,
    'lstk',
    // 引数から先頭のグローバルフラグを除いたサブコマンド名を雑に拾う。
    `printf '%s endpoint=[%s]\\n' "$*" "\${AWS_ENDPOINT_URL-<unset>}" >> "${log}"\n` +
      // `lstk status` は「既に動いている」ことにして start を短絡させない:
      // status は失敗させ、start は成功させる。
      `case "$1" in status) exit 1 ;; esac\nexit 0`,
  );
  writeExe(dir, 'npm', 'exit 0');

  return { dir, log };
}

function run(dir: string, subcommand: string) {
  return spawnSync('bash', [SCRIPT, subcommand], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      // このテストは lstk へ渡る env だけを見る。コンテナ自前起動の経路は別テスト。
      LOCAL_AWS_CONTAINER_MODE: 'lstk',
    },
  });
}

function lifecycleCalls(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    // `lstk aws ...`（データ面）は対象外。相手取るのはコンテナのライフサイクルのみ。
    .filter((l) => !l.startsWith('aws ') && !/(^|\s)aws\s/.test(l.split(' endpoint=')[0] ?? ''));
}

describe('local-aws.sh が lstk ライフサイクルへ渡す環境', () => {
  it(
    '🔴 start は AWS_ENDPOINT_URL を見ない（lstk が拒否するため）',
    () => {
      const { dir, log } = fakeEnv();
      const result = run(dir, 'up');

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

      const calls = lifecycleCalls(log);
      expect(calls.length, 'lstk が 1 度も呼ばれていない').toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `ライフサイクル命令が endpoint を見ている: ${call}`).toContain(
          'endpoint=[<unset>]',
        );
      }
    },
    TIMEOUT,
  );

  it(
    '🔴 それでもレーン自体は LocalStack を向いたままであること（下界）',
    () => {
      // これが無いと「AWS_ENDPOINT_URL を一切 export しない」実装でも上のテストは通る。
      // その実装はアプリと AWS CLI を**実 AWS へ**向けるので、最も危険な誤りである。
      const { dir } = fakeEnv();
      const result = spawnSync('bash', [SCRIPT, 'env'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: TIMEOUT,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('AWS_ENDPOINT_URL=http://localhost.localstack.cloud:4566');
    },
    TIMEOUT,
  );

  it(
    'down も同じ扱いであること（stop は start と同じ制約を持つ）',
    () => {
      const { dir, log } = fakeEnv();
      const result = run(dir, 'down');

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      const calls = lifecycleCalls(log);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `stop が endpoint を見ている: ${call}`).toContain('endpoint=[<unset>]');
      }
    },
    TIMEOUT,
  );
});

/**
 * `lstk aws` の**案内行が stdout に混ざる**ことへの耐性。
 *
 * ## なぜ要るか（2026-09-14 に実測）
 *
 * `lstk aws ...` は値の前に
 *
 * ```
 * > Note: No AWS profile found, run 'lstk setup aws'
 * ```
 *
 * を **stdout へ**出す。`--query ... --output text` の捕捉にそのまま使うと、
 * 捕捉結果は `"> Note: ...\nENABLED"` になり、`= "ENABLED"` の比較が**必ず外れる**。
 *
 * 結果として `bootstrap_table` は TTL が既に有効でも毎回有効化しに行き、2 回目の
 * `up` が `TimeToLive is already enabled` (ValidationException) で落ちた。
 * **`up` が冪等でない**ということで、`test` / `reset` も同じ経路を通るので全部落ちる。
 *
 * 🔴 ここで縛るのは「既に有効なら**触らない**」という下界である。エラーを握り潰す
 * フォールバックでは同じ緑になるが、それは症状を**沈黙の誤動作へ変換**するだけで、
 * 捕捉が壊れていること自体は隠れたままになる。
 */
describe('local-aws.sh が lstk の案内行に耐えること', () => {
  function fakeEnvWithBanner() {
    const dir = mkdtempSync(join(tmpdir(), 'local-aws-banner-'));
    const log = join(dir, 'lstk-calls.log');

    writeExe(dir, 'docker', 'if [ "$1" = "info" ]; then exit 0; fi\nexit 0');
    writeExe(dir, 'dockerd', 'exit 0');
    writeExe(
      dir,
      'lstk',
      `printf '%s\\n' "$*" >> "${log}"\n` +
        // 実物と同じく、案内行を **stdout** に出す。
        `printf '%s\\n' "> Note: No AWS profile found, run 'lstk setup aws'"\n` +
        `case "$*" in\n` +
        `  *describe-time-to-live*) printf 'ENABLED\\n'; exit 0 ;;\n` +
        `  *describe-table*) exit 0 ;;\n` +
        `  *status*) exit 1 ;;\n` +
        `esac\nexit 0`,
    );
    writeExe(dir, 'npm', 'exit 0');
    return { dir, log };
  }

  it(
    '🔴 TTL が既に有効なら、有効化し直さない（up が冪等であること）',
    () => {
      const { dir, log } = fakeEnvWithBanner();
      const result = spawnSync('bash', [SCRIPT, 'up'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: TIMEOUT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          LOCAL_AWS_CONTAINER_MODE: 'lstk',
        },
      });

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

      const calls = readFileSync(log, 'utf8');
      // 上界: 状態は読みに行っていること（読まずに素通りする実装を弾く）。
      expect(calls).toContain('describe-time-to-live');
      // 🔴 下界: 既に有効なのに書きに行っていないこと。
      expect(calls, '既に ENABLED なのに TTL を有効化し直している').not.toContain(
        'update-time-to-live',
      );
    },
    TIMEOUT,
  );
});
