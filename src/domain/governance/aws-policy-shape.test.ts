/**
 * IAM ポリシー JSON の構造検証 (spec §11)。
 *
 * 「policy を見る限り安全」で終わらせないための最初の網。**実 API 評価は
 * `scripts/aws-negative-tests.ts` の SimulatePrincipalPolicy が担う**ので、ここでは
 * 「書き忘れ」と「明らかな穴」だけを機械で押さえる。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditPolicyDocument, type PolicyDocument } from './aws-policy-shape';

const load = (name: string): PolicyDocument =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/aws-policies', name), 'utf8')) as PolicyDocument;

describe('auditPolicyDocument', () => {
  it('Allow の Action:* + Resource:* を管理者権限として検出する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    });
    expect(audit.grantsAdmin).toBe(true);
  });

  it('Allow の Action:* でも Resource が限定されていれば管理者ではない', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: 'arn:aws:s3:::example/*' }],
    });
    expect(audit.grantsAdmin).toBe(false);
  });

  it('Deny されている ARN パターンを列挙する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Deny', Action: 'cloudformation:*', Resource: 'arn:aws:cloudformation:*:*:stack/nodi-*/*' },
      ],
    });
    expect(audit.deniedResourcePatterns).toContain('arn:aws:cloudformation:*:*:stack/nodi-*/*');
  });

  it('boundary 条件の無い iam:CreateRole の Allow を検出する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iam:CreateRole', Resource: '*' }],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('PermissionsBoundary 条件付きの iam:CreateRole は検出しない', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: {
            StringEquals: {
              'iam:PermissionsBoundary':
                'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary',
            },
          },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(false);
  });

  it('StringEqualsIfExists は boundary 条件と認めない（キー欠如時に true になる）', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: {
            StringEqualsIfExists: {
              'iam:PermissionsBoundary':
                'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary',
            },
          },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('Null 演算子は boundary 条件と認めない（キーの不在を主張しうる）', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: { Null: { 'iam:PermissionsBoundary': 'true' } },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('Action / Resource が配列でも文字列でも同じに扱う', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: ['s3:*'], Resource: ['arn:aws:s3:::nodi-*'] }],
    });
    expect(audit.deniedResourcePatterns).toContain('arn:aws:s3:::nodi-*');
  });

  it('Deny の NotResource を Resource とは別に集計する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Action: 'cloudformation:*',
          NotResource: ['arn:aws:cloudformation:*:*:stack/OpenReception-Web-dev/*'],
        },
      ],
    });
    expect(audit.deniedNotResourcePatterns).toContain(
      'arn:aws:cloudformation:*:*:stack/OpenReception-Web-dev/*',
    );
    expect(audit.deniedResourcePatterns).toEqual([]);
  });
});

/** 他プロジェクトの列挙。spec の Global Constraints と 1:1。 */
const FOREIGN_PATTERNS = ['nodi-', 'salon-loop-', 'Kiaff', 'cdk-hnb659fds-', 'cdk-staging-'];

describe('claude-boundary.json', () => {
  const doc = load('claude-boundary.json');

  it('管理者権限を与えない', () => {
    expect(auditPolicyDocument(doc).grantsAdmin).toBe(false);
  });

  it('boundary 条件の無い Role 作成を許さない', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreation).toBe(false);
  });

  it.each(FOREIGN_PATTERNS)('%s を Deny している', (pattern) => {
    const denied = auditPolicyDocument(doc).deniedResourcePatterns.join('\n');
    expect(denied).toContain(pattern);
  });

  it.each([
    'iam:DeleteRolePermissionsBoundary',
    'iam:PutRolePermissionsBoundary',
    'route53:*',
    'acm:*',
    'iam:CreateUser',
    'iam:CreateAccessKey',
  ])('%s を Deny している', (action) => {
    expect(auditPolicyDocument(doc).deniedActions).toContain(action);
  });

  it('boundary 自身の書き換えを Deny している', () => {
    const denied = auditPolicyDocument(doc).deniedResourcePatterns.join('\n');
    expect(denied).toContain('policy/OpenReceptionClaudeBoundary');
  });
});

describe('claude-cfn-exec.json', () => {
  const doc = load('claude-cfn-exec.json');

  it('管理者権限を与えない（既定 bootstrap の AdministratorAccess を使わない理由）', () => {
    expect(auditPolicyDocument(doc).grantsAdmin).toBe(false);
  });

  it('secretsmanager を Deny している（dev には 1 つも存在しない）', () => {
    expect(auditPolicyDocument(doc).deniedActions).toContain('secretsmanager:*');
  });

  it('boundary 条件の無い Role 作成を許さない', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreation).toBe(false);
  });

  it.each(FOREIGN_PATTERNS)('%s を Deny している', (pattern) => {
    expect(auditPolicyDocument(doc).deniedResourcePatterns.join('\n')).toContain(pattern);
  });
});

describe('claude-deploy-entry.json', () => {
  const doc = load('claude-deploy-entry.json');
  const audit = auditPolicyDocument(doc);

  it('管理者権限を与えない', () => {
    expect(audit.grantsAdmin).toBe(false);
  });

  it('既定 qualifier のロールへの AssumeRole を Deny している', () => {
    const denied = audit.deniedResourcePatterns.join('\n');
    expect(denied).toContain('cdk-hnb659fds-');
    expect(denied).toContain('cdk-staging-');
  });

  it('専用 qualifier のロールへの AssumeRole だけを Allow している', () => {
    const allowed = audit.allowedResourcePatterns.join('\n');
    expect(allowed).toContain('cdk-orcloud01-');
    expect(allowed).not.toContain('cdk-hnb659fds-');
  });

  // 🔴 Critical 1（2026-08-12 全体レビュー）: bootstrap の lookup role には AWS 管理の
  // `ReadOnlyAccess` が付き（`bootstrap-template.yaml:495-496`）、インライン Deny は
  // `kms:Decrypt` のみ。`--custom-permissions-boundary` が boundary を付けるのは
  // cfn-exec role だけ（同 740 行目）なので lookup role は境界の外にある。
  // entry role がこれを assume できると、層 1・3 の主境界を丸ごと迂回して
  // アカウント全体（nodi / salon-loop / Kiaff）を読めてしまう。
  // dev は context provider を使わないため、allowlist に入れてはならない。
  it('allowlist に lookup role を含まない（ReadOnlyAccess 経由でアカウント全体を読めてしまう）', () => {
    for (const pattern of audit.allowedResourcePatterns) {
      expect(pattern).not.toContain('lookup-role');
    }
  });

  it('lookup role への AssumeRole を明示 Deny している（allowlist へ再追加されても Deny が勝つ）', () => {
    expect(audit.deniedResourcePatterns.join('\n')).toContain('lookup-role');
  });

  // Important 5a（2026-08-12 レビュー）: `run_diff_gate` が
  // `cloudformation:DescribeStacks` / `DescribeChangeSet` を呼ぶには、entry role 自身に
  // 読み取り専用の Allow が要る（さもないと N4 の live check「OpenReception-Web-dev を
  // describe → expect allowed」が構造的に絶対通らない）。この Allow は
  // OpenReception-*-dev の 3 スタックだけに絞られていなければならない
  // ―― 広すぎると他プロジェクト（nodi/salon-loop 等）や prod/staging の
  // CloudFormation を読めてしまい、主境界の外側に穴を開ける。
  it('read-only 診断用 Allow (ReadOwnDevStacksForDiffGate) は OpenReception-*-dev の CloudFormation だけを対象にしている', () => {
    const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
      v === undefined ? [] : typeof v === 'string' ? [v] : v;
    const stmt = doc.Statement.find(
      (s) => s.Effect === 'Allow' && list(s.Action).includes('cloudformation:DescribeStacks'),
    );
    expect(stmt).toBeDefined();
    const resources = list(stmt!.Resource);
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(r).toMatch(/^arn:aws:cloudformation:[a-z0-9-]+:822063948773:stack\/OpenReception-[A-Za-z0-9]+-dev\/\*$/);
    }
    // 他プロジェクト・他環境が紛れ込んでいないことも明示的に確認する。
    const joined = resources.join('\n');
    for (const foreign of ['nodi-', 'salon-loop-', '-prod/', '-staging/']) {
      expect(joined).not.toContain(foreign);
    }
  });

  it('DenyEverythingElseOutsideTheChain の NotAction は診断用 Allow と同じ範囲だけを許容する', () => {
    const denyAll = doc.Statement.find(
      (s) => (s as unknown as { Sid?: string }).Sid === 'DenyEverythingElseOutsideTheChain',
    );
    expect(denyAll).toBeDefined();
    const notAction = denyAll!.NotAction;
    const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
      v === undefined ? [] : typeof v === 'string' ? [v] : v;
    // 🔴 Important C（2026-08-12 レビュー）: `arrayContaining` は「少なくともこれらを
    // 含む」だけを見るので、誰かが後から `iam:*` や `*` を追加しても素通りする
    // ―― `auditPolicyDocument` は `NotAction` を集計しないため、この主境界の
    // 拡大を検出できるのは実質この 1 テストだけだった。Finding 6 と同じ欠陥の型
    // （「名前が主張する保証を実際には検証していない」）が再発したので、
    // 完全一致 `toEqual` に直す。
    expect(list(notAction)).toEqual([
      'sts:AssumeRole',
      'sts:GetCallerIdentity',
      'cloudformation:DescribeStacks',
      'cloudformation:DescribeChangeSet',
    ]);
  });

  // Important A（2026-08-12 レビュー）: `cloudformation:DescribeChangeSet` は
  // AWS Service Authorization Reference 上 `changeset` リソースタイプに対して認可される
  // （`stack` ではない）。`ReadOwnDevStacksForDiffGate` に混ぜていた旧実装は
  // stack ARN しか Allow しておらず、`run_diff_gate` が実際に呼ぶ
  // `describe-change-set` が構造的に Deny され続けていた。`ReadOwnChangeSetsForDiffGate`
  // を別ステートメントへ分離し、changeSet ARN（`claude-gate-*` という名前のものだけ）に
  // 絞ったことを固定する。
  it('read-only 診断用 Allow (ReadOwnChangeSetsForDiffGate) は claude-gate-* の changeSet だけを対象にしている', () => {
    const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
      v === undefined ? [] : typeof v === 'string' ? [v] : v;
    const stmt = doc.Statement.find(
      (s) => s.Effect === 'Allow' && list(s.Action).includes('cloudformation:DescribeChangeSet'),
    );
    expect(stmt).toBeDefined();
    // stack リソースタイプの Allow に紛れ込んでいない（別ステートメントである）ことも確認する。
    expect(list(stmt!.Action)).not.toContain('cloudformation:DescribeStacks');
    const resources = list(stmt!.Resource);
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(r).toMatch(/^arn:aws:cloudformation:[a-z0-9-]+:822063948773:changeSet\/claude-gate-\*\/\*$/);
    }
    const joined = resources.join('\n');
    for (const foreign of ['nodi-', 'salon-loop-', '-prod/', '-staging/', 'stack/']) {
      expect(joined).not.toContain(foreign);
    }
  });
});

describe('claude-deploy-role-restriction.json（層 1・主境界）', () => {
  const audit = auditPolicyDocument(load('claude-deploy-role-restriction.json'));

  it('許可スタック以外への cloudformation を Deny している', () => {
    const denied = audit.deniedResourcePatterns.join('\n');
    expect(denied).toContain('stack/nodi-');
    expect(denied).toContain('stack/salon-loop-');
    expect(denied).toContain('stack/OpenReception-*-prod/');
    expect(denied).toContain('stack/OpenReception-*-staging/');
  });

  it('Allow を一切含まない（既存 deploy role への上乗せ Deny だけ）', () => {
    expect(audit.allowedResourcePatterns).toEqual([]);
    expect(audit.grantsAdmin).toBe(false);
  });

  it('共有 bootstrap の cfn-exec-role への PassRole を Deny している', () => {
    expect(audit.deniedActions).toContain('iam:PassRole');
    expect(audit.deniedResourcePatterns.join('\n')).toContain('cdk-hnb659fds-');
  });

  it('NotResource 許可リストが dev の 3 スタックと専用 Toolkit を挙げている', () => {
    const patterns = audit.deniedNotResourcePatterns.join('\n');
    expect(patterns).toContain('stack/OpenReception-Web-dev/');
    expect(patterns).toContain('stack/OpenReception-WebMonitoring-dev/');
    expect(patterns).toContain('stack/OpenReception-CfMonitoring-dev/');
    expect(patterns).toContain('stack/CDKToolkit-orcloud01/');
  });

  it('NotResource 許可リストにワイルドカード単体を含まない（主境界を無効化する）', () => {
    expect(audit.deniedNotResourcePatterns).not.toContain('*');
    for (const p of audit.deniedNotResourcePatterns) {
      expect(p).toMatch(/^arn:aws:cloudformation:/);
    }
  });

  // Important A（2026-08-12 レビュー）: このファイルは deploy role（`cdk-orcloud01-*`）に
  // 上乗せする Deny。`cloudformation:*` の Deny を `NotResource`（許可リスト）で除外して
  // いるが、`cloudformation:DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet` は
  // changeSet リソースタイプに対して認可されるため、stack ARN しか列挙していないと
  // それらのアクションが**常に** Deny に一致してしまい、`cdk deploy` 自体が構造的に
  // 動かなくなる。dev の 3 スタック・専用 Toolkit・自分の change set（`claude-gate-*`）
  // だけを許可リストへ加えたことを、各エントリの形として固定する
  // （`claude-deploy-entry.json` の同種テストと対になる「equivalent assertion」）。
  it('NotResource 許可リストの各エントリは stack（dev/専用 Toolkit）か changeSet（claude-gate-*）のいずれかの正しい形をしている', () => {
    const stackOrChangeSet =
      /^arn:aws:cloudformation:[a-z0-9-]+:822063948773:(stack\/(OpenReception-[A-Za-z0-9]+-dev|CDKToolkit-orcloud01)\/\*|changeSet\/claude-gate-\*\/\*)$/;
    expect(audit.deniedNotResourcePatterns.length).toBeGreaterThan(0);
    for (const p of audit.deniedNotResourcePatterns) {
      expect(p).toMatch(stackOrChangeSet);
    }
    const joined = audit.deniedNotResourcePatterns.join('\n');
    for (const foreign of ['nodi-', 'salon-loop-', 'Kiaff', '-prod/', '-staging/']) {
      expect(joined).not.toContain(foreign);
    }
  });
});

describe('claude-deploy-entry-trust.json', () => {
  const doc = load('claude-deploy-entry-trust.json');

  it('user/CDK だけを信頼し ExternalId を要求する', () => {
    const raw = JSON.stringify(doc);
    expect(raw).toContain('arn:aws:iam::822063948773:user/CDK');
    expect(raw).toContain('sts:ExternalId');
  });

  it('Principal が * でない', () => {
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('"Principal":"*"');
    expect(raw).not.toContain('"AWS":"*"');
  });
});
