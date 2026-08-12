/**
 * `scripts/aws-issue-credentials.sh` の安全性検証 (spec §8)。
 *
 * **秘密の値を出力・保存しないこと**が本スクリプトの唯一かつ最大の要件なので、
 * そこを機械で固定する。AWS へは接続しない（引数検証と本文の性質だけ見る）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/aws-issue-credentials.sh');
const source = readFileSync(SCRIPT, 'utf8');

function run(args: ReadonlyArray<string>) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: err.status ?? -1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('値を残さない', () => {
  it('credential をファイルへ書き出さない', () => {
    expect(source).not.toMatch(/>\s*[^&|\s]*credential/i);
    expect(source).not.toContain('~/.aws/credentials');
  });

  it('既定では値を標準出力へ出さない（--print を明示したときだけ）', () => {
    expect(source).toContain('--print');
    // echo で SecretAccessKey を直接出す行が無いこと
    expect(source).not.toMatch(/echo\s+.*SecretAccessKey/);
  });

  it('set -x（トレース）を有効にしない', () => {
    expect(source).not.toMatch(/^\s*set\s+-[a-z]*x/m);
  });
});

describe('引数の検証', () => {
  it('--hours に 12 を超える値を拒否する', () => {
    const { status, stderr } = run(['--hours', '13']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('12');
  });

  it('--hours に数値でない値を拒否する', () => {
    expect(run(['--hours', 'abc']).status).not.toBe(0);
  });
});

describe('チェーンを固定する', () => {
  it('専用 entry role を assume する', () => {
    expect(source).toContain('OpenReceptionClaudeDeploy-dev');
  });

  it('ExternalId を渡す', () => {
    expect(source).toContain('--external-id');
  });
});

describe('VITEST 実行中は AWS を呼ばない（実測で見つかった事故の再発防止）', () => {
  // 🔴 `--hours` の上限チェック（12 を境界とする分岐）を一時的に破壊してテストしたとき
  // （変異テスト）、境界をすり抜けた値がこの安全装置を追加する前は実際に
  // `aws sts assume-role` まで到達し、ローカル Mac に設定済みの実資格情報で
  // AWS STS への本物の API 呼び出しが発生した（`ValidationError` で失敗し資格情報の
  // 発行はされなかったが、意図しない実通信が起きた事実は残る）。
  // `scripts/aws-cloud-deploy.sh` の `collect_observation` と同じ VITEST インターロックを
  // 追加し、それが実際に境界チェックより後・aws 呼び出しより前で機能することを固定する。
  // このプロセス自身が vitest 配下で動いているため `VITEST` は子プロセスへ継承される
  // （上書きしない）。
  it('妥当な --hours でも VITEST 配下では AWS を呼ばずに止まる', () => {
    const { status, stderr } = run(['--hours', '1']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('VITEST');
  });
});
