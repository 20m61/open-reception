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
import {
  auditPolicyDocument,
  conditionOperatorsForKey,
  strictConditionKeys,
  type PolicyDocument,
} from './aws-policy-shape';

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

  // 🔴 Minor 11（2026-08-12 全体レビュー）: 検出器は `Action:*`+`Resource:*` と
  // 無条件 `iam:CreateRole` しか見ておらず、Finding 4/5 の昇格プリミティブ
  // （`iam:PassRole` on `*` / `iam:CreatePolicyVersion` on `*` / `iam:DeleteRole` on `*`）を
  // 素通りさせていた。
  describe('IAM 昇格プリミティブの検出', () => {
    it('iam:PassRole を Resource:* で無条件に Allow していたら検出する', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'iam:PassRole', Resource: '*' }],
      });
      expect(audit.unscopedPassRole).toBe(true);
    });

    it('lambda:* のような prefix ワイルドカードでなく iam:* でも検出する', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'iam:*', Resource: '*' }],
      });
      expect(audit.unscopedPassRole).toBe(true);
    });

    it('iam:PassedToService で絞ってあれば検出しない', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: '*',
            Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
          },
        ],
      });
      expect(audit.unscopedPassRole).toBe(false);
    });

    it('aws:ResourceTag で絞ってあれば検出しない', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: '*',
            Condition: { StringEquals: { 'aws:ResourceTag/Project': 'open-reception' } },
          },
        ],
      });
      expect(audit.unscopedPassRole).toBe(false);
    });

    // boundary 条件で踏んだのと同じ罠。`*IfExists` はキー欠如時に無条件で true を返すので
    // 「絞っている」ことにならない。
    it('StringEqualsIfExists の PassedToService は「絞っている」と認めない', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: '*',
            Condition: { StringEqualsIfExists: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
          },
        ],
      });
      expect(audit.unscopedPassRole).toBe(true);
    });

    it('iam:CreatePolicyVersion を Resource:* で Allow していたら検出する', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['iam:CreatePolicyVersion'], Resource: '*' }],
      });
      expect(audit.unscopedPolicyRewrite).toBe(true);
      expect(audit.unscopedRoleWrite).toBe(false);
    });

    it('iam:DeleteRole を Resource:* で Allow していたら検出する', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['iam:DeleteRole'], Resource: '*' }],
      });
      expect(audit.unscopedRoleWrite).toBe(true);
      expect(audit.unscopedPolicyRewrite).toBe(false);
    });

    it('Resource が絞られていれば昇格プリミティブとして検出しない', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['iam:DeleteRole', 'iam:CreatePolicyVersion'],
            Resource: 'arn:aws:iam::822063948773:role/OpenReception-*',
          },
        ],
      });
      expect(audit.unscopedRoleWrite).toBe(false);
      expect(audit.unscopedPolicyRewrite).toBe(false);
    });

    it('IAM 書き込み系の Deny に列挙された ARN パターンを別集計する', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            Action: ['iam:DeleteRole'],
            Resource: ['arn:aws:iam::822063948773:role/cdk-hnb659fds-*'],
          },
          // IAM 書き込みと無関係な Deny は混ざらない。
          { Effect: 'Deny', Action: ['s3:*'], Resource: ['arn:aws:s3:::nodi-*'] },
        ],
      });
      expect(audit.iamWriteDenyPatterns).toEqual(['arn:aws:iam::822063948773:role/cdk-hnb659fds-*']);
    });
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

/**
 * 層 2・層 4 の**主体**となる 2 ポリシー（exec role の権限と、その天井）。
 * 両方に同じ性質を要求する ―― 片方だけ直すと、もう片方が抜け道になる。
 */
const ESCALATION_SCOPED_POLICIES = ['claude-boundary.json', 'claude-cfn-exec.json'] as const;

/**
 * Important 5（2026-08-12 全体レビュー）で塞いだ、名前で列挙できる IAM 書き込み先。
 * `cdk-orcloud01-*` と `OpenReceptionClaudeDeploy-dev` を含むのが重要 —— **自分の
 * チェーン**を書き換えられると主境界そのものが外れる（`iam:DeleteRolePolicy` で
 * deploy role から層 1 のインラインポリシーを剥がす、など）。
 */
const IAM_WRITE_DENY_REQUIRED = [
  'role/cdk-hnb659fds-',
  'role/cdk-staging-',
  'role/cdk-orcloud01-',
  'role/OpenReceptionClaudeDeploy-dev',
  'role/nodi-',
  'role/salon-loop-',
  'role/Kiaff',
  'policy/cdk-hnb659fds-',
  'policy/nodi-',
  'policy/salon-loop-',
  'policy/SalonLoop',
  'policy/OpenReceptionClaude',
  'user/*',
];

describe.each(ESCALATION_SCOPED_POLICIES)('%s の IAM 昇格経路', (name) => {
  const audit = auditPolicyDocument(load(name));

  // 🔴 Important 4: 層 2 の論拠は「広い grant は dev スタックのテンプレートが要求した
  // ときにしか行使されない」だったが、そのテンプレートを書くのは脅威モデル（spec §3）が
  // 侵害を仮定しているサンドボックス自身である。`Role.fromRoleArn(<既存の別ロール>)` を
  // Lambda に渡す変更は change set 上 `AWS::Lambda::Function` の `Add`（SAFE_ACTION）に
  // しか見えず、gate は止めも記録もしない。PassRole 側で絞るしかない。
  it('iam:PassRole を Resource:* で無条件に Allow していない (Important 4)', () => {
    expect(audit.unscopedPassRole).toBe(false);
  });

  it('iam:PassRole の Allow は PassedToService とタグの両方で絞っている', () => {
    const stmt = load(name).Statement.find(
      (s) => s.Effect === 'Allow' && JSON.stringify(s.Action).includes('iam:PassRole'),
    );
    expect(stmt).toBeDefined();
    const keys = strictConditionKeys(stmt!);
    expect(keys).toContain('iam:passedtoservice');
    expect(keys).toContain('aws:resourcetag/project');
    expect(keys).toContain('aws:resourcetag/environment');
  });

  // 🔴 Important 5: 出荷しているポリシーは `iam:DeleteRole` / `CreatePolicyVersion` 等を
  // `Resource: "*"` で Allow している（CDK が自分のロール・ポリシーを更新するのに要る）。
  // よって「広くないこと」は主張できない。**広いなら、名前による明示 Deny が揃っている
  // こと**を要求する。実装した以上のカバレッジを主張しないための形。
  it('ロール/ポリシーの破壊系が広いなら、外部プリンシパルへの明示 Deny が揃っている (Important 5)', () => {
    if (!audit.unscopedRoleWrite && !audit.unscopedPolicyRewrite) return;
    const patterns = audit.iamWriteDenyPatterns.join('\n');
    for (const required of IAM_WRITE_DENY_REQUIRED) {
      expect(patterns).toContain(required);
    }
  });

  it('タグで絞れる範囲（role）については Project タグ以外への書き込みも Deny している', () => {
    const stmt = load(name).Statement.find(
      (s) => (s as unknown as { Sid?: string }).Sid === 'DenyIamRoleWriteOutsideProject',
    );
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe('Deny');
    // `StringNotEquals`（キー欠如時に真＝fail-closed）であることまで固定する。
    // `StringNotEqualsIfExists` にするとタグ無しロールを素通りさせてしまう。
    expect(conditionOperatorsForKey(stmt!, 'aws:ResourceTag/Project')).toEqual(['StringNotEquals']);
    expect(JSON.stringify(stmt!.Action)).toContain('iam:DeleteRole');
  });
});

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

  // 🔴 Critical 2（2026-08-12 全体レビュー）の副作用: boundary は cfn-exec role だけの
  // 天井ではなくなった。`infra/bin/open-reception.ts` が `-c claudeBoundary=` を受けて
  // **アプリが作る全 Role**（server Lambda / image Lambda / custom resource）にも付ける。
  // Permissions Boundary は天井なので、ここに無いアクションは identity policy が
  // 許可していても実行時に効かない ―― **デプロイは成功するのに機能だけ壊れる**。
  //
  // dev の server Lambda は `infra/lib/constructs/cost-explorer-access.ts` で
  // `ce:GetCostAndUsage` / `ce:GetCostForecast` を持つ（developer コスト画面 #377）。
  // これを天井から落とすと画面が実行時 AccessDenied になる。
  it('dev の実行ロールが必要とする Cost Explorer read を天井に含む（#377 を壊さない）', () => {
    const allowed = auditPolicyDocument(doc).allowedActions;
    expect(allowed).toContain('ce:GetCostAndUsage');
    expect(allowed).toContain('ce:GetCostForecast');
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
