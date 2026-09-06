import { describe, expect, it } from 'vitest';
import {
  allowedActionsForService,
  cliSubcommandToActionName,
  extractAwsCliInvocations,
  extractFencedBlocks,
  extractSection,
  unexecutableInvocations,
  type EntryPolicyDocument,
} from './entry-role-cli';

/** 実物（`claude-deploy-entry.json`）と同じ形の最小ポリシー。 */
const ENTRY_LIKE: EntryPolicyDocument = {
  Statement: [
    {
      Sid: 'ReadOwnDevStacksForDiffGate',
      Effect: 'Allow',
      Action: ['cloudformation:DescribeStacks', 'cloudformation:DescribeChangeSet'],
    },
    { Effect: 'Allow', Action: 'sts:AssumeRole' },
    // Deny は見ない（Allow に無い＝実行できない）。Deny を数えると読み違える。
    { Effect: 'Deny', Action: 'cloudformation:*' },
  ] as EntryPolicyDocument['Statement'],
};

describe('entry-role-cli: CLI サブコマンド → IAM action', () => {
  it('kebab-case を PascalCase へ直す', () => {
    expect(cliSubcommandToActionName('describe-change-set')).toBe('DescribeChangeSet');
    expect(cliSubcommandToActionName('get-template')).toBe('GetTemplate');
    expect(cliSubcommandToActionName('list-change-sets')).toBe('ListChangeSets');
    expect(cliSubcommandToActionName('deploy')).toBe('Deploy');
  });
});

describe('entry-role-cli: Allow の読み出し', () => {
  it('対象サービスの Allow だけを拾う（Deny は数えない）', () => {
    const { wildcard, actions } = allowedActionsForService(ENTRY_LIKE, 'cloudformation');
    expect(wildcard).toBe(false);
    expect([...actions].sort()).toEqual([
      'cloudformation:describechangeset',
      'cloudformation:describestacks',
    ]);
  });

  it('Allow が 1 つも無いサービスは空（判定不能を PASS へ倒さない）', () => {
    const { wildcard, actions } = allowedActionsForService(ENTRY_LIKE, 'iam');
    expect(wildcard).toBe(false);
    expect(actions.size).toBe(0);
  });

  it('ワイルドカードは全 Allow として扱う', () => {
    expect(allowedActionsForService({ Statement: [{ Effect: 'Allow', Action: '*' }] }, 'cloudformation').wildcard).toBe(
      true,
    );
    expect(
      allowedActionsForService({ Statement: [{ Effect: 'Allow', Action: 'cloudformation:*' }] }, 'cloudformation')
        .wildcard,
    ).toBe(true);
  });
});

describe('entry-role-cli: テキストからの抽出', () => {
  it('aws 呼び出しを拾い、重複を畳む', () => {
    const text = [
      'aws cloudformation describe-change-set --stack-name X \\',
      '  --region ap-northeast-1',
      'aws cloudformation describe-change-set --include-property-values',
      'aws sts get-caller-identity',
    ].join('\n');
    expect(extractAwsCliInvocations(text).map((i) => i.action).sort()).toEqual([
      'cloudformation:DescribeChangeSet',
      'sts:GetCallerIdentity',
    ]);
  });

  it('オプションが続く形（aws --version）は呼び出しとして拾わない', () => {
    expect(extractAwsCliInvocations('aws --version')).toEqual([]);
  });

  it('🔴 行頭でない呼び出しも拾う（コマンド置換・連結）', () => {
    // 行頭だけを見る実装だと、`CS=$(aws ...)` や `... && aws ...` を丸ごと見落とす。
    // 最初に書いた 9b-1 の手順がまさに `$(aws cloudformation list-change-sets ...)` だった。
    const text = [
      'CS=$(aws cloudformation list-change-sets --stack-name X --output text)',
      'npm run build && aws cloudformation describe-stacks --stack-name X',
    ].join('\n');
    expect(extractAwsCliInvocations(text).map((i) => i.action).sort()).toEqual([
      'cloudformation:DescribeStacks',
      'cloudformation:ListChangeSets',
    ]);
  });

  it('コードフェンスの中だけを取り出す（散文の禁止例を拾わない）', () => {
    const md = [
      '本文で `aws cloudformation get-template` は使えないと書く。',
      '',
      '```bash',
      'aws cloudformation describe-change-set --stack-name X',
      '```',
      '',
      '```text',
      'aws cloudformation delete-stack --stack-name X',
      '```',
    ].join('\n');
    const bash = extractFencedBlocks(md, 'bash').join('\n');
    expect(extractAwsCliInvocations(bash).map((i) => i.action)).toEqual([
      'cloudformation:DescribeChangeSet',
    ]);
    // 下界: 散文側には確かに禁止例が居る（フェンス抽出が空を返しているだけではない）。
    expect(extractAwsCliInvocations(md).map((i) => i.action)).toContain('cloudformation:GetTemplate');
  });

  it('節を切り出す（次の同レベル見出しまで）', () => {
    const md = ['## A', 'alpha', '### A-1', 'bravo', '## B', 'charlie'].join('\n');
    expect(extractSection(md, '### A-1')).toContain('bravo');
    expect(extractSection(md, '### A-1')).not.toContain('charlie');
    expect(extractSection(md, '## A')).toContain('bravo');
    expect(extractSection(md, '## A')).not.toContain('charlie');
  });

  it('🔴 bash ブロックの行コメントで節を打ち切らない（空虚な green を作る型）', () => {
    // `# 1. …` は見出しの正規表現に一致する。素朴な実装だとここで節が切れ、
    // その下のコマンドが検査対象から消えて「違反ゼロ」に見える。
    const md = [
      '### 手順',
      '```bash',
      '# 1. まず現状を見る',
      'aws cloudformation describe-change-set --stack-name X',
      '```',
      '### 次の節',
      'aws cloudformation get-template',
    ].join('\n');
    const section = extractSection(md, '### 手順');
    expect(section).toContain('describe-change-set');
    expect(section).not.toContain('get-template');
    expect(extractAwsCliInvocations(extractFencedBlocks(section, 'bash').join('\n'))).toHaveLength(1);
  });

  it('見つからない見出しは空を返す（呼び出し側が検出できる）', () => {
    expect(extractSection('## A\nbody', '### 無い見出し')).toBe('');
  });
});

describe('entry-role-cli: 実行できない呼び出しの判定', () => {
  it('Allow に無い action を実行不能として返す', () => {
    const invocations = extractAwsCliInvocations(
      ['aws cloudformation describe-change-set --x', 'aws cloudformation get-template --x'].join('\n'),
    );
    expect(unexecutableInvocations(invocations, ENTRY_LIKE).map((i) => i.action)).toEqual([
      'cloudformation:GetTemplate',
    ]);
  });

  it('🔴 2026-09-06 に実際に踏んだ 2 つを両方とも捕まえる', () => {
    // get-template … runbook 9b が勧めていた（AccessDenied）
    // list-change-sets … その置き換えを書くときに私が使いかけた（Allow に無い）
    const invocations = extractAwsCliInvocations(
      ['aws cloudformation get-template', 'aws cloudformation list-change-sets'].join('\n'),
    );
    expect(unexecutableInvocations(invocations, ENTRY_LIKE)).toHaveLength(2);
  });

  it('Allow を全部消すと全件が実行不能になる（空を返す変異を落とす下界）', () => {
    const invocations = extractAwsCliInvocations('aws cloudformation describe-change-set --x');
    expect(unexecutableInvocations(invocations, ENTRY_LIKE)).toEqual([]);
    expect(unexecutableInvocations(invocations, { Statement: [] })).toHaveLength(1);
  });
});
