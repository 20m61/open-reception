/**
 * `scripts/aws-diff-gate.ts` の振る舞い検証。
 *
 * AWS 資格情報を必要としない（change set の JSON ファイル 1 つを読むだけ）ので、
 * `tests/hooks/aws-preflight.test.ts` と同じ方針で直接子プロセス実行して確かめる。
 *
 * 「Status を見ずに Changes だけで判定すると fail-open になる」（2026-08-12 レビュー）を固定する。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(process.cwd(), 'scripts/aws-diff-gate.ts');
const STACK = 'OpenReception-Web-dev';

function writeChangeSet(value: unknown): string {
  const path = join(tmpdir(), `aws-diff-gate-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(jsonPath: string, stack: string = STACK) {
  const result = spawnSync('npx', ['tsx', CLI, jsonPath, stack], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('change set の Status を無視しない (fail-open の修正)', () => {
  it('Status が FAILED（Changes は空）だと、変更 0 件でも安全とは判定しない', () => {
    // 現実の CloudFormation はまさにこの形を返しうる: 作成失敗で Changes が空のまま。
    const path = writeChangeSet({
      StackName: STACK,
      Status: 'FAILED',
      StatusReason: 'Unable to fetch parameters',
      Changes: [],
    });
    const { status, stderr, stdout } = run(path);
    expect(status).not.toBe(0);
    expect(stderr).toContain('CREATE_COMPLETE');
    expect(stderr).toContain('FAILED');
    // 誤って「安全」メッセージを出していないことも確認する。
    expect(stdout).not.toContain('危険な変更はありません');
  });

  it('Status が欠落していても安全とは判定しない', () => {
    const path = writeChangeSet({ StackName: STACK, Changes: [] });
    const { status, stderr } = run(path);
    expect(status).not.toBe(0);
    expect(stderr).toContain('CREATE_COMPLETE');
  });

  it('Status が CREATE_COMPLETE かつ変更が安全なら通す', () => {
    const path = writeChangeSet({
      StackName: STACK,
      Status: 'CREATE_COMPLETE',
      Changes: [
        { ResourceChange: { Action: 'Add', ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'Fn' } },
      ],
    });
    const { status, stdout } = run(path);
    expect(status).toBe(0);
    expect(stdout).toContain('危険な変更はありません');
  });

  it('Status が CREATE_COMPLETE でも危険な変更（Replacement）は引き続き止める', () => {
    const path = writeChangeSet({
      StackName: STACK,
      Status: 'CREATE_COMPLETE',
      Changes: [
        {
          ResourceChange: {
            Action: 'Modify',
            ResourceType: 'AWS::DynamoDB::Table',
            LogicalResourceId: 'DataTable',
            Replacement: 'True',
          },
        },
      ],
    });
    const { status, stderr } = run(path);
    expect(status).not.toBe(0);
    expect(stderr).toContain('resourceReplacement');
  });
});
