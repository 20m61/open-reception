/**
 * `scripts/aws-cloud-deploy.sh` の振る舞い検証 (spec §5)。
 *
 * `tests/hooks/guard-destructive.test.ts` と同じ方針: 実際に起動して確かめる。
 * **AWS へは接続しない** — 未知のサブコマンドと引数検証、および
 * 「AWS 認証情報が無いときに黙って成功しない」ことを固定する。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = resolve(process.cwd(), 'scripts/aws-cloud-deploy.sh');

function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync('bash', [WRAPPER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: err.status ?? -1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe('引数の検証', () => {
  it('サブコマンド無しは usage を出して非ゼロ', () => {
    const { status, stderr } = run([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('未知のサブコマンドは非ゼロ', () => {
    const { status, stderr } = run(['destroy']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('destroy');
  });

  it.each(['preflight', 'verify', 'diff', 'deploy', 'smoke'])('%s は既知のサブコマンド', (sub) => {
    const { stderr } = run([sub, '--help']);
    expect(stderr).not.toContain('未知のサブコマンド');
  });
});

describe('環境の固定', () => {
  it('env=dev 以外を拒否する', () => {
    const { status, stderr } = run(['diff'], { OR_DEPLOY_ENV: 'prod' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('dev');
  });

  it('AWS 認証情報が無い状態で成功と報告しない', () => {
    const { status } = run(['preflight'], {
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: 'definitely-not-a-real-profile',
    });
    expect(status).not.toBe(0);
  });
});

describe('危険な既定を持たない', () => {
  it('スクリプト本文に --force / --require-approval never を含まない', () => {
    const source = execFileSync('cat', [WRAPPER], { encoding: 'utf8' });
    expect(source).not.toContain('--require-approval never');
    expect(source).not.toContain('--no-verify');
  });

  it('既定 qualifier hnb659fds を使わない', () => {
    const source = execFileSync('cat', [WRAPPER], { encoding: 'utf8' });
    expect(source).toContain('orcloud01');
    expect(source).not.toContain('hnb659fds');
  });
});
