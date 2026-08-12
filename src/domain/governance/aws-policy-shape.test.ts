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
  type PolicyStatement,
} from './aws-policy-shape';
import { CARVE_OUT_ROLE_ARN_PATTERN, iamArnGlobMatches } from './cfn-generated-name';
import {
  CARVE_OUT_ALLOWED_ACTIONS,
  CARVE_OUT_ALLOWED_RESOURCE_PREFIX,
} from './deploy-diff-gate';

const load = (name: string): PolicyDocument =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/aws-policies', name), 'utf8')) as PolicyDocument;

const ROLE_ARN_PREFIX = 'arn:aws:iam::822063948773:role/';

/**
 * CDK の `CustomResourceProvider` が作るロールだけを外す carve-out (#680 R1/R2/R3)。
 *
 * **なぜこの形か**: 物理名は
 * `<スタック名>-<論理 ID を 64 文字に収まるまで切り詰めたもの>-<12 文字の乱数>` で、
 * 切り詰め量が**スタック名の長さで変わる**。`OpenReception-Web-dev` では
 * `CustomCrossRegionExportWriter` まで残るが、`OpenReception-CfMonitoring-dev` では
 * `CustomCrossRegionExp` で切れる。したがって
 * `…-Custom*CustomResourceProviderRole*` も `…-CustomCrossRegionExport*` も
 * **us-east-1 側に一致しない**（`cfn-generated-name.test.ts` が実在名 2 本で固定）。
 * 一致しなければ `iam:CreateRole` が Deny され、初回デプロイが ROLLBACK_FAILED になる。
 *
 * 🔴 **「これが取りうる最も狭いパターンである」とは主張しない（訂正。#680 R10）。**
 * 2 本に分ければ（`…-CustomCrossRegion*` ＋ `…-CustomS3AutoDelete*`）より狭く、
 * `claude-boundary.json` の残り文字数にも収まる。1 本にしてあるのは、
 * **どのみち名前グロブでは敵対的なテンプレートを防げない**からである ——
 * 論理 ID はテンプレートを書く側が決められ、切り詰めで区別できるサフィックスは
 * 物理名から消える。狭さが買えるのは**事故耐性だけ**で、それを理由に
 * スタック名の長さ変更で壊れる脆いパターンを選ぶ価値は無い。
 * 敵対的なテンプレートを止めるのは `deploy-diff-gate.ts` である。
 *
 * 定数は `cfn-generated-name.ts` に一本化してある —— gate とポリシーが別々の
 * 文字列を持つと「ポリシーは carve-out しているが gate は別の名前空間を見ている」
 * というずれが黙って生まれる。ここではその 1 本が出荷 JSON と一致することを固定する。
 */
const PROVIDER_ROLE_CARVE_OUT = CARVE_OUT_ROLE_ARN_PATTERN;

/** Sid で 1 ステートメントを取り出す。見つからなければ throw（無言 PASS を作らない）。 */
function bySid(doc: PolicyDocument, sid: string): PolicyStatement {
  const stmt = doc.Statement.find((s) => (s as unknown as { Sid?: string }).Sid === sid);
  if (stmt === undefined) throw new Error(`Sid が見つかりません: ${sid}`);
  return stmt;
}

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
    // 🔴 Sid で取る。`find(Action に iam:PassRole を含む最初の Allow)` だと、#680 R2 で
    // 追加した carve-out（タグ条件を意図的に持たない）を掴んで意味が反転しうる。
    const keys = strictConditionKeys(bySid(load(name), 'AllowPassRoleOnlyToTaggedDevWorkloads'));
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
    const stmt = bySid(load(name), 'DenyIamRoleWriteOutsideProject');
    expect(stmt.Effect).toBe('Deny');
    // `StringNotEquals`（キー欠如時に真＝fail-closed）であることまで固定する。
    // `StringNotEqualsIfExists` にするとタグ無しロールを素通りさせてしまう。
    expect(conditionOperatorsForKey(stmt, 'aws:ResourceTag/Project')).toEqual(['StringNotEquals']);
    expect(JSON.stringify(stmt.Action)).toContain('iam:DeleteRole');
  });

  /**
   * 🔴 **R1/R2/R3（2026-08-12 残件レビュー / #680）: CDK custom-resource provider role の
   * carve-out。**
   *
   * `crossRegionReferences` / `autoDeleteObjects` の provider role は生の
   * `AWS::IAM::Role` として吐かれ、cross-region の 2 本には `PermissionsBoundary` が
   * 付かず、3 本とも `Project` / `Environment` タグが付かない
   * （`infra/test/claude-deploy-boundary.test.ts` が synth で実測して固定している）。
   * その結果 —— carve-out を入れないと ——
   *
   *  1. 初回デプロイの `iam:CreateRole` が `DenyRoleCreationWithoutBoundary` に当たって
   *     AccessDenied → rollback
   *  2. rollback の `iam:DeleteRole` が `DenyIamRoleWriteOutsideProject`（タグ条件）に
   *     当たって **ROLLBACK_FAILED**
   *  3. provider Lambda への `iam:PassRole` が `aws:ResourceTag/Project` 条件で Deny
   *
   * **Deny は Allow に勝つ**ので、Allow を足すだけでは 1 も 2 も解けない。
   * Deny 側を `NotResource` へ変えて carve-out を除外してある。ここではその 5 点
   * （Allow 2 本・Deny 2 本の `NotResource`・パターンが広すぎないこと）を固定する。
   */
  describe('CDK custom-resource provider role の carve-out (#680 R1/R2/R3)', () => {
    const doc = () => load(name);

    it('boundary 条件なしの CreateRole Allow は carve-out パターン 1 本だけ', () => {
      // 「無い」ではなく「これだけ」。`*` や `role/*` へ広げたら落ちる。
      expect(auditPolicyDocument(doc()).unboundedRoleCreationResources).toEqual([PROVIDER_ROLE_CARVE_OUT]);
    });

    it('carve-out の Allow は Create/Put/Attach の 3 つだけで、Condition を持たない', () => {
      const stmt = bySid(doc(), 'AllowCdkProviderRoleMutationWithoutBoundary');
      expect(stmt.Effect).toBe('Allow');
      expect(stmt.Action).toEqual(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy']);
      expect(stmt.Resource).toBe(PROVIDER_ROLE_CARVE_OUT);
    });

    it('carve-out の PassRole は lambda.amazonaws.com へのみ、素の StringEquals で絞る', () => {
      const stmt = bySid(doc(), 'AllowPassRoleToCdkProviderRoles');
      expect(stmt.Resource).toBe(PROVIDER_ROLE_CARVE_OUT);
      expect(stmt.Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
      });
      // タグ条件は落としてよいが、渡し先の縛りは落とさない（#680 R2 の明示条件）。
      expect(strictConditionKeys(stmt)).toEqual(['iam:passedtoservice']);
    });

    it.each([
      // 層 4 の boundary 強制。carve-out 以外の**すべて**を Deny し続ける。
      name === 'claude-boundary.json'
        ? 'DenyRoleCreationWithoutThisBoundary'
        : 'DenyRoleCreationWithoutBoundary',
      // 層 3 のタグ条件 Deny。rollback / teardown の DeleteRole を通すために除外する。
      'DenyIamRoleWriteOutsideProject',
    ])('%s は Resource:* ではなく NotResource で carve-out だけを除外している', (sid) => {
      const stmt = bySid(doc(), sid);
      expect(stmt.Effect).toBe('Deny');
      // 🔴 `Resource` が残っていたら carve-out は効かない（Deny が Allow に勝つ）。
      expect(stmt.Resource).toBeUndefined();
      expect(stmt.NotResource).toBe(PROVIDER_ROLE_CARVE_OUT);
    });
  });
});

/**
 * carve-out が「意図より広いものに一致しない」ことを、グロブ照合で直接確かめる。
 * ARN パターンは目視で安全かどうか分からない —— 実際に当ててみる。
 */
describe('carve-out パターンの広がり (#680 R1/R2/R3)', () => {
  it.each([
    // 実在する 2 本（アカウント上で確認済み）と、us-east-1 側の予測名。
    'OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw',
    'OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-yIrNw85NvcWP',
    'OpenReception-CfMonitoring-dev-CustomCrossRegionExp-aBcDeFgHiJkL',
  ])('%s に一致する', (roleName) => {
    expect(iamArnGlobMatches(PROVIDER_ROLE_CARVE_OUT, `${ROLE_ARN_PREFIX}${roleName}`)).toBe(true);
  });

  it.each([
    // アプリの通常ロール（boundary もタグも付く）。免除してはならない。
    'OpenReception-Web-dev-ServerFnServiceRoleABCD-aBcDeFgHiJkL',
    // 環境違い。carve-out は dev 専用。
    'OpenReception-Web-prod-CustomCrossRegionExportWriter-aBcDeFgHiJkL',
    'OpenReception-Web-staging-CustomCrossRegionExportWriter-aBcDeFgHiJkL',
    // 自分のチェーン・他プロジェクト・エントリロール。
    'cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1',
    'cdk-hnb659fds-cfn-exec-role-822063948773-ap-northeast-1',
    'nodi-dev-CustomSomething-aBcDeFgHiJkL',
    'OpenReceptionClaudeDeploy-dev',
    // 大小文字を変えただけの名前も一致しない。
    'openreception-web-dev-customcrossregionexportwriter-aBcDeFgHiJkL',
  ])('%s に一致しない', (roleName) => {
    expect(iamArnGlobMatches(PROVIDER_ROLE_CARVE_OUT, `${ROLE_ARN_PREFIX}${roleName}`)).toBe(false);
  });
});

describe('claude-boundary.json', () => {
  const doc = load('claude-boundary.json');

  it('管理者権限を与えない', () => {
    expect(auditPolicyDocument(doc).grantsAdmin).toBe(false);
  });

  // #680 R1: 「無い」ではなく「carve-out だけ」。詳細は carve-out describe を参照。
  it('boundary 条件の無い Role 作成は carve-out 以外に無い', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreationResources).toEqual([PROVIDER_ROLE_CARVE_OUT]);
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

  // #680 R1: 「無い」ではなく「carve-out だけ」。詳細は carve-out describe を参照。
  it('boundary 条件の無い Role 作成は carve-out 以外に無い', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreationResources).toEqual([PROVIDER_ROLE_CARVE_OUT]);
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

/**
 * 🔴 **ドキュメントと出荷ポリシーの一致を機械で押さえる (#680 R6/R9)。**
 *
 * このレビューが拾った欠陥の型は「**出荷物と食い違う説明**」だった ——
 * spec §4.2 は `stack/OpenReception-*-dev/*` を層 1 の allowlist として示しつつ
 * すぐ下で「`*` ワイルドカードは使っていない」と書き、実際の JSON は 3 スタックを
 * 実名で列挙していた。人が読んで気づくまで誰も落ちなかった。
 * **数字と列挙は、書いた瞬間に腐る。テストで縛る。**
 */
describe('ドキュメントが出荷ポリシーと一致している (#680 R6/R9)', () => {
  const readDoc = (relative: string): string =>
    readFileSync(resolve(process.cwd(), relative), 'utf8');

  const SPEC = 'docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md';
  const RUNBOOK = 'docs/runbook-cloud-aws-deploy.md';

  /** 見出しの直後に現れる最初のフェンス済みコードブロックの中身を返す。 */
  function fencedBlockAfter(markdown: string, heading: string): ReadonlyArray<string> {
    const at = markdown.indexOf(heading);
    if (at === -1) throw new Error(`見出しが見つかりません: ${heading}`);
    const open = markdown.indexOf('```', at);
    if (open === -1) throw new Error(`${heading} の後にコードブロックがありません`);
    const bodyStart = markdown.indexOf('\n', open) + 1;
    const close = markdown.indexOf('```', bodyStart);
    if (close === -1) throw new Error(`${heading} のコードブロックが閉じていません`);
    return markdown
      .slice(bodyStart, close)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  it('spec §4.2 層 1 のコード塊は claude-deploy-role-restriction.json の NotResource そのもの', () => {
    const shipped = auditPolicyDocument(load('claude-deploy-role-restriction.json'))
      .deniedNotResourcePatterns;
    expect(shipped.length).toBeGreaterThan(0);
    expect(fencedBlockAfter(readDoc(SPEC), '#### 層 1（主境界）')).toEqual([...shipped]);
  });

  /**
   * 🔴 **gate の残余説明を出荷物へ縛る（2026-08-13 レビュー）。**
   *
   * このラウンドで指摘された欠陥は「runbook と spec が gate の固定範囲を
   * **実装より強く**書いていた」ことだった（`iam*` は弾けていないのに
   * 「IAM 昇格は塞いだ」と書いてあった）。**説明が実装より強い文書は、
   * 停止境界の判断を誤らせる。** 数と語彙を機械で縛る。
   */
  describe('gate の carve-out action 許可リスト', () => {
    const normalize = (s: string): string => s.replace(/\s+/g, '');

    it.each([SPEC, RUNBOOK])('%s が許可リストの本数を正しく書いている', (doc) => {
      const count = CARVE_OUT_ALLOWED_ACTIONS.size;
      expect(count).toBeGreaterThan(0);
      expect(normalize(readDoc(doc))).toContain(normalize(`${count} つの \`ssm:\` アクション`));
    });

    it('許可リストは ssm: だけで構成されている（文書の「6 つの ssm」が真であること）', () => {
      expect([...CARVE_OUT_ALLOWED_ACTIONS].filter((a) => !a.startsWith('ssm:'))).toEqual([]);
    });

    /**
     * 🔴 action の許可リストだけを書いて `Resource` の閉じ込めに触れない文書は、
     * **残余を実際より狭く見せる**（`ssm:DeleteParameters` on `*` は
     * アカウント全体の SSM を消せる）。両方が書かれていることを縛る。
     */
    it.each([SPEC, RUNBOOK])('%s が Resource の閉じ込め先を書いている', (doc) => {
      // 🔴 **コードの定数から引き、バッククォート込みで探す。** 素の部分一致だと
      // 定数を `parameter/` へ広げても文書の `parameter/cdk/exports/` が
      // 部分文字列として一致してしまい、**実装だけ広がって文書が置き去り**でも緑になる。
      const quoted = `\`${CARVE_OUT_ALLOWED_RESOURCE_PREFIX}\``;
      expect(normalize(readDoc(doc))).toContain(normalize(quoted));
    });

    it('🔴 撤回した否認リストの語彙が gate の説明に残っていない', () => {
      // 否認リスト（`iam:` `sts:` `kms:` … を弾く）は 2026-08-13 に許可リストへ
      // 反転した。古い語彙が残っていると「塞いである」と誤読される。
      for (const doc of [SPEC, RUNBOOK]) {
        const gateSections = readDoc(doc)
          .split('\n')
          .filter((line) => line.includes('carveOutRoleShape'));
        expect(gateSections.length).toBeGreaterThan(0);
        expect(gateSections.join('\n')).not.toContain('organizations:');
      }
    });
  });

  /**
   * managed policy の 6,144 文字上限に対する余白。**runbook に書いた数字が実測と
   * ずれたら落とす** —— 「まだ余裕がある」と思って足した人が
   * `LimitExceeded` を初回適用で踏むのを防ぐ。
   */
  it.each(['claude-boundary.json', 'claude-cfn-exec.json'] as const)(
    'runbook ステップ 1 が %s の実サイズと残り文字数を正しく書いている',
    (name) => {
      const size = JSON.stringify(load(name)).length;
      expect(size).toBeLessThanOrEqual(6144);
      const runbook = readDoc(RUNBOOK);
      const fmt = (n: number): string => n.toLocaleString('en-US');
      expect(runbook).toContain(fmt(size));
      expect(runbook).toContain(fmt(6144 - size));
    },
  );
});

describe('claude-deploy-entry-trust.json', () => {
  const doc = load('claude-deploy-entry-trust.json');

  it('user/CDK だけを信頼する', () => {
    const raw = JSON.stringify(doc);
    expect(raw).toContain('arn:aws:iam::822063948773:user/CDK');
  });

  /**
   * 🔴 Minor 10（2026-08-12 全体レビュー）: 旧アサーションは
   * `expect(raw).toContain('sts:ExternalId')` だけだった。
   * `StringEqualsIfExists` は **ExternalId を渡さないリクエストに対して無条件で true を
   * 返す**ため、この形でも文字列としては一致し、**ExternalId を任意にしても緑のまま**になる。
   * ラウンド 2 で `iam:PermissionsBoundary` について直したのと同じ欠陥である。
   * 演算子と値を両方固定する。
   */
  it('ExternalId は素の StringEquals で必須化されている（*IfExists / Null を許さない）', () => {
    const stmt = doc.Statement[0];
    expect(stmt).toBeDefined();
    expect(conditionOperatorsForKey(stmt!, 'sts:ExternalId')).toEqual(['StringEquals']);
    expect(strictConditionKeys(stmt!)).toContain('sts:externalid');
    expect(stmt!.Condition).toEqual({
      StringEquals: { 'sts:ExternalId': 'open-reception-claude-cloud-dev' },
    });
  });

  it('Principal が * でない', () => {
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('"Principal":"*"');
    expect(raw).not.toContain('"AWS":"*"');
  });
});
