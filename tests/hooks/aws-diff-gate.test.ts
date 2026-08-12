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

describe('「変更なし」の FAILED は誤検出しない（自己申告した留保事項の修正、2026-08-12 レビュー）', () => {
  // CDK 自身が全く同じ判定をしている: infra/node_modules/aws-cdk/lib/index.js の
  // changeSetHasNoChanges() で確認済み（Status === 'FAILED' かつ StatusReason が
  // 次の 2 文字列のどちらかで始まる）。3 スタックをループする diff/deploy では、
  // 少なくとも 1 つが「変更なし」なのが通常運用であり、これを毎回ハードストップに
  // すると自動デプロイが実質使えなくなる。
  it.each([
    ["The submitted information didn't contain changes.", '通常テンプレートの無変更'],
    ['No updates are to be performed.', 'Transform を含むテンプレートの無変更（#10650）'],
    // 接頭辞一致であることも確認する（完全一致ではなく startsWith）。
    ["The submitted information didn't contain changes. (詳細な補足が続く場合)", '接頭辞一致（末尾に補足がある場合）'],
  ])('StatusReason=%s は変更なしとして通す（%s）', (statusReason) => {
    const path = writeChangeSet({ StackName: STACK, Status: 'FAILED', StatusReason: statusReason, Changes: [] });
    const { status, stdout } = run(path);
    expect(status).toBe(0);
    expect(stdout).toContain('変更なし');
    expect(stdout).toContain('危険な変更はありません');
  });

  it('接頭辞に一致しない FAILED は引き続きハードストップする（無関係なエラーまで通さない）', () => {
    const path = writeChangeSet({
      StackName: STACK,
      Status: 'FAILED',
      StatusReason: 'Unable to fetch parameters',
      Changes: [],
    });
    const { status, stderr, stdout } = run(path);
    expect(status).not.toBe(0);
    expect(stderr).toContain('CREATE_COMPLETE');
    expect(stdout).not.toContain('変更なし');
  });

  // 🔴 LOW fail-open（2026-08-12 レビュー第 3 ラウンド）: no-op 早期 return は
  // evaluateDeployChangeSet を経由しないため、Task 1 由来の unexpectedStack 検証を
  // スキップしてしまっていた。foreign スタックを名乗る「変更なし」ペイロードを拒否する
  // ことを固定する。
  it('foreign スタックを名乗る「変更なし」ペイロードは拒否する（unexpectedStack のスキップを許さない）', () => {
    const path = writeChangeSet({
      StackName: 'nodi-dev-app',
      Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes.",
      Changes: [],
    });
    const { status, stderr, stdout } = run(path, 'nodi-dev-app');
    expect(status).not.toBe(0);
    expect(stderr).toContain('許可パターン');
    expect(stdout).not.toContain('変更なし');
    expect(stdout).not.toContain('危険な変更はありません');
  });

  // no-op 理由文字列を持ちながら実は Changes が空でない（本来ありえないが、入力を
  // 信頼しない）ペイロードは、isNoOpChangeSet が false を返して通常のハードストップへ
  // 落ちることを固定する。
  it('no-op 理由文字列を持ちながら Changes が空でないペイロードは拒否する', () => {
    const path = writeChangeSet({
      StackName: STACK,
      Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes.",
      Changes: [
        { ResourceChange: { Action: 'Add', ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'Fn' } },
      ],
    });
    const { status, stderr, stdout } = run(path);
    expect(status).not.toBe(0);
    expect(stderr).toContain('CREATE_COMPLETE');
    expect(stdout).not.toContain('変更なし');
    expect(stdout).not.toContain('危険な変更はありません');
  });
});
