/**
 * ローカル AWS レーン（LocalStack）が、実 AWS 資格情報から隔離されていることを
 * 実際に bash を起動して検証する（#1103 AC1 / PR #1102）。
 *
 * ## なぜ要るか（2026-09-14 に実際に踏んだ）
 *
 * `scripts/local-aws.sh` は資格情報をこう置いていた:
 *
 * ```bash
 * export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
 * export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
 * ```
 *
 * `:-` は「**未設定なら**」なので、**AWS のデプロイ窓が開いているセッションでは
 * 実 STS 資格情報をそのまま引き継ぐ**。`AWS_SESSION_TOKEN` に至っては unset すら
 * していなかったので、短命 STS の 3 点セットが揃ってローカルレーンへ流れ込む。
 *
 * #1103 の AC1 は「実 AWS 資格情報**なしに** LocalStack を起動できること」だが、
 * 上の書き方は**それをスクリプトとして保証していない**。実害は「送り先が localhost
 * である限り小さい」だが、小さいことと保証があることは別である ―― `AWS_ENDPOINT_URL`
 * を取り違えた瞬間に実資格情報で実 AWS を叩く。
 *
 * ## 何を縛るか
 *
 * 🔴 **「dummy が入っている」だけを主張しない。** それは全部が壊れた世界でも通りうる
 * （`CLAUDE.md`「検証の作法」の下界の話）。**実資格情報の値が出力のどこにも現れない**
 * ことを併せて縛る ―― 値そのものを sentinel にして 0 回であることを数える。
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const SCRIPT = join(ROOT, 'scripts/local-aws.sh');
const TIMEOUT = 60_000;

/**
 * 実資格情報に見える sentinel。**本物ではない**（形だけ本物に似せてある）。
 * 出力に 1 度でも現れたら、隔離が効いていない。
 */
const REAL = {
  AWS_ACCESS_KEY_ID: 'ASIAREALSENTINEL00000',
  AWS_SECRET_ACCESS_KEY: 'realSecretSentinel0000000000000000000000',
  AWS_SESSION_TOKEN: 'realSessionTokenSentinel0000000000000000',
  AWS_PROFILE: 'real-admin-profile-sentinel',
} as const;

function runEnvSubcommand(extraEnv: Record<string, string>) {
  return spawnSync('bash', [SCRIPT, 'env'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...extraEnv },
  });
}

describe('local-aws.sh の資格情報隔離', () => {
  it(
    'env サブコマンドは docker / lstk が無くても観測できる（前提の無い環境で診断できること）',
    () => {
      const result = runEnvSubcommand({});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('AWS_ENDPOINT_URL=');
    },
    TIMEOUT,
  );

  it(
    '実 AWS 資格情報が環境にあっても、ローカルレーンへ引き継がない',
    () => {
      const result = runEnvSubcommand(REAL);
      expect(result.status).toBe(0);

      const out = `${result.stdout}${result.stderr}`;

      // 上界: dummy が入っていること。
      expect(out).toContain('AWS_ACCESS_KEY_ID=test');
      expect(out).toContain('AWS_SECRET_ACCESS_KEY=test');
      // 短命 STS の 3 点目。残っていると実資格情報として成立してしまう。
      expect(out).toContain('AWS_SESSION_TOKEN=<unset>');
      // プロファイル経由の解決も塞ぐ（~/.aws/credentials を拾わせない）。
      expect(out).toContain('AWS_PROFILE=<unset>');

      // 🔴 下界: 実資格情報の値が 1 度も現れないこと。
      // 「dummy が入っている」だけだと、両方が出力される実装でも通ってしまう。
      for (const [name, value] of Object.entries(REAL)) {
        expect(out, `${name} の値が出力に漏れている`).not.toContain(value);
      }
    },
    TIMEOUT,
  );

  it(
    'ローカルレーンの宛先が LocalStack のままであること（実 AWS を向いていない）',
    () => {
      const result = runEnvSubcommand(REAL);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('AWS_ENDPOINT_URL=http://localhost.localstack.cloud:4566');
      expect(result.stdout).toContain('DATA_BACKEND=dynamodb');
      // amazonaws.com を向いていたら、それは実 AWS への経路である。
      expect(result.stdout).not.toContain('amazonaws.com');
    },
    TIMEOUT,
  );
});
