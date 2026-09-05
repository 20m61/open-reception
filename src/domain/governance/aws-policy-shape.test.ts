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
 * `CustomCrossRegionExportWriter` まで残るが、`OpenReception-CfMon-dev` では
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

    /**
     * 🔴 **2026-09-05 に反転したアサーション。**
     *
     * かつてここは「`aws:ResourceTag` で絞ってあれば検出しない」と書いてあり、
     * 検出器もそう実装されていた ―― **テストと実装が同じ誤った前提を共有していた**
     * （`CLAUDE.md`「検証の作法」冒頭の型）。誤りは「IAM は Role のタグで
     * `iam:PassRole` を認可できる」で、実際には評価されず Allow ごと消える。
     *
     * どちらとも言えないものは fail-closed 側（絞れていない）に倒す。
     */
    it('aws:ResourceTag は PassRole を絞らない（IAM が評価しないので絞れていない扱い）', () => {
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
      expect(audit.unscopedPassRole).toBe(true);
    });

    it.each(['aws:ResourceTag/Project', 'iam:ResourceTag/Project'])(
      '%s を条件に持つ PassRole の Allow は「死んでいる」として名指しする',
      (key) => {
        const audit = auditPolicyDocument({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: 'iam:PassRole',
              Resource: '*',
              Condition: { StringEquals: { [key]: 'open-reception' } },
            },
          ],
        });
        expect(audit.deadPassRoleConditionKeys).toEqual([key.toLowerCase()]);
      },
    );

    /**
     * **下界。** 「空になる」だけを主張すると、検出器を常に空にする変異が素通りする。
     * 上の 2 本が「入る」側、これが「入らない」側。
     */
    it('渡し先を ARN で絞った PassedToService だけの Allow は死んでいない', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: 'arn:aws:iam::822063948773:role/OpenReception-*-dev-*',
            Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
          },
        ],
      });
      expect(audit.deadPassRoleConditionKeys).toEqual([]);
      expect(audit.unscopedPassRole).toBe(false);
    });

    /**
     * 🔴 **`Resource` が絞られていても死ぬ。** 「ARN で絞ってあるから安全」と思って
     * タグ条件を足すと、Allow は静かに消える。`unscopedPassRole` は false のままなので、
     * そちらだけを見ていると検出できない。
     */
    it('Resource を絞ってあってもタグ条件が付いていれば死んでいると名指しする', () => {
      const audit = auditPolicyDocument({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: 'arn:aws:iam::822063948773:role/OpenReception-*-dev-*',
            Condition: {
              StringEquals: {
                'iam:PassedToService': 'lambda.amazonaws.com',
                'aws:ResourceTag/Project': 'open-reception',
              },
            },
          },
        ],
      });
      expect(audit.unscopedPassRole).toBe(false);
      expect(audit.deadPassRoleConditionKeys).toEqual(['aws:resourcetag/project']);
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

  /**
   * 🔴 **2026-09-05: タグ条件から ARN 条件へ切り替えた（ADR 0009 決定 6 の撤回）。**
   *
   * 旧実装は `Resource: "*"` ＋ `aws:ResourceTag/Project` ＋ `aws:ResourceTag/Environment`
   * で絞ったつもりだったが、`iam:PassRole` はリソース（Role）のタグでは認可できない。
   * その結果この Allow は**一度も成立せず**、dev デプロイの `iam:PassRole` が
   * `AccessDenied` になって `UPDATE_ROLLBACK_FAILED` に落ちた。
   * 渡し先は ARN で絞り、条件は IAM が実際に評価する `iam:PassedToService` だけにする。
   */
  it('iam:PassRole の Allow は渡し先を ARN で絞り、PassedToService を条件に持つ', () => {
    // 🔴 Sid で取る。`find(Action に iam:PassRole を含む最初の Allow)` だと、#680 R2 で
    // 追加した carve-out を掴んで意味が反転しうる。
    const stmt = bySid(load(name), 'AllowPassRoleOnlyToDevWorkloadRoles');
    expect(stmt.Resource).toBe('arn:aws:iam::822063948773:role/OpenReception-*-dev-*');
    expect(stmt.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
    expect(strictConditionKeys(stmt)).toEqual(['iam:passedtoservice']);
  });

  /**
   * 🔴 **下界。** 上のテストは「この綴りであること」しか言わない。渡し先が実際に
   * dev の Lambda 実行ロールを覆っていること（＝ 2026-09-05 に落ちた当のリクエストが
   * 通ること）と、他プロジェクトを覆っていないことを、グロブ照合で直接確かめる。
   */
  it.each([
    ['OpenReception-Web-dev-ServerFnServiceRole-xxxx', true],
    ['OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw', true],
    ['OpenReception-Web-prod-ServerFnServiceRole-xxxx', false],
    ['salon-loop-staging-SomeRole', false],
    ['cdk-hnb659fds-cfn-exec-role-822063948773-ap-northeast-1', false],
  ] as const)('PassRole の渡し先 %s を覆うか = %s', (roleName, expected) => {
    const stmt = bySid(load(name), 'AllowPassRoleOnlyToDevWorkloadRoles');
    const pattern = stmt.Resource;
    if (typeof pattern !== 'string') throw new Error('Resource が単一の文字列ではない');
    expect(iamArnGlobMatches(pattern, `arn:aws:iam::822063948773:role/${roleName}`)).toBe(expected);
  });

  /**
   * 🔴 **`*IfExists` の逆側の欠陥を検出器で固定する（2026-09-05）。**
   *
   * 「条件を書いたのに IAM が評価しない」型は、綴りの上では正しい条件付き Allow に
   * 見える。**書けたことと効いていることは別**であり、この型は
   * 「デプロイが AccessDenied で落ちる」までどのテストにも現れなかった。
   */
  it('iam:PassRole の Allow に、IAM が評価しない条件キーが残っていない', () => {
    expect(audit.deadPassRoleConditionKeys).toEqual([]);
  });

  // 🔴 Important 5: 出荷しているポリシーは `iam:DeleteRole` / `CreatePolicyVersion` 等を
  // `Resource: "*"` で Allow している（CDK が自分のロール・ポリシーを更新するのに要る）。
  // よって「広くないこと」は主張できない。**広いなら、名前による明示 Deny が揃っている
  // こと**を要求する。実装した以上のカバレッジを主張しないための形。
  /**
   * 🔴 **綴りではなく被覆で見る。** かつてはパターン文字列に
   * `role/cdk-hnb659fds-` が**含まれるか**を見ていたが、それは*形*であって*意味*ではない。
   * 2026-08-15 に 6144 文字上限へ収めるため `role/cdk-hnb659fds-*` と
   * `policy/cdk-hnb659fds-*` を `*` + `/cdk-hnb659fds-*` へ畳んだところ、
   * **被覆は広がったのにこのテストだけが落ちた**。
   *
   * 実 ARN を組み立てて「どれかの Deny 資源に一致するか」を見れば、
   * 書き方を変えても意味が保たれていることを固定できる。
   */
  it('ロール/ポリシーの破壊系が広いなら、外部プリンシパルへの明示 Deny が揃っている (Important 5)', () => {
    if (!audit.unscopedRoleWrite && !audit.unscopedPolicyRewrite) return;
    for (const required of IAM_WRITE_DENY_REQUIRED) {
      // 実 ARN を組み立てる。エントリは 3 種類ある:
      //   `user/*`                            … ワイルドカード → 具体名へ差し替え
      //   `role/cdk-hnb659fds-`               … 接頭辞         → 続きを足す
      //   `role/OpenReceptionClaudeDeploy-dev` … 完全名        → そのまま
      const suffix = required.endsWith('*')
        ? `${required.slice(0, -1)}example`
        : required.endsWith('-')
          ? `${required}example`
          : required;
      const arn = `arn:aws:iam::822063948773:${suffix}`;
      const covered = audit.iamWriteDenyPatterns.some((p) => iamArnGlobMatches(p, arn));
      expect(covered, `${arn} を覆う Deny 資源が無い（${name}）`).toBe(true);
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
    'OpenReception-CfMon-dev-CustomCrossRegionExp-aBcDeFgHiJkL',
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

/**
 * 🔴 **2026-08-14 の実地デプロイで踏んだ欠陥の回帰テスト。**
 *
 * 脱出防止のつもりで `iam:PutRolePermissionsBoundary` を**条件なし**で Deny していたため、
 * 「既存ロールに**我々の**境界を付ける」という正当な操作まで死んでいた。dev の Lambda
 * 実行ロールは境界が仕組みに入る前に作られており、初回デプロイはまさにこれを必要とする。
 * 結果 `OpenReception-Web-dev` が `UPDATE_ROLLBACK_FAILED` に落ちた
 * （rollback 側は `DeleteRolePermissionsBoundary` が Deny されて失敗）。
 *
 * 禁じたいのは動詞（Put / Delete）ではなく**遷移の向き**である:
 *
 * - **外す** … 一切不可（`Delete` は無条件 Deny のまま）
 * - **弱いものへ差し替える** … 不可（`Put` は我々の境界 ARN 以外なら Deny）
 * - **我々の境界を付ける** … 可（これを塞いでいたのが欠陥）
 *
 * 既存の「Deny している」テスト（`deniedActions` に含まれる）は、条件付き Deny でも
 * 通ってしまうため**この性質を固定できない**。ここで直接ドキュメントを見る。
 */
describe('permissions boundary の付け外し (#680 実地デプロイの回帰)', () => {
  const boundary = load('claude-boundary.json');
  const cfnExec = load('claude-cfn-exec.json');
  const BOUNDARY_ARN = 'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary';

  const actionsOf = (s: PolicyStatement): ReadonlyArray<string> =>
    typeof s.Action === 'string' ? [s.Action] : (s.Action ?? []);

  /**
   * その action を **条件なし・`Resource:"*"`** で Deny している文（＝逃げ場のない包括禁止）。
   *
   * 🔴 **`Resource` が資源リストの Deny は数えない。** `DenyIamWriteOnForeignPrincipals` は
   * 他プロジェクトのロール（`nodi-*` / `salon-loop-*` / `cdk-*` 等）に対して条件なしで
   * Put も Delete も Deny しており、これは**正当で残すべき**もの。我々のアプリロール
   * （`OpenReception-*-dev-*`）はそのリストに含まれない。ここで見たいのは
   * 「アプリロールにも及ぶ包括 Deny があるか」だけである。
   */
  const unconditionalDenies = (doc: PolicyDocument, action: string): ReadonlyArray<PolicyStatement> =>
    doc.Statement.filter(
      (s) =>
        s.Effect === 'Deny' &&
        actionsOf(s).includes(action) &&
        s.Condition === undefined &&
        s.Resource === '*',
    );

  const conditionalDenies = (doc: PolicyDocument, action: string): ReadonlyArray<PolicyStatement> =>
    doc.Statement.filter(
      (s) => s.Effect === 'Deny' && actionsOf(s).includes(action) && s.Condition !== undefined,
    );

  it('🔴 境界を外す（Delete）は無条件で Deny されている', () => {
    expect(unconditionalDenies(boundary, 'iam:DeleteRolePermissionsBoundary').length).toBeGreaterThan(0);
  });

  it('🔴 境界を付ける（Put）を無条件で Deny していない（既存ロールへ後付けできる）', () => {
    expect(unconditionalDenies(boundary, 'iam:PutRolePermissionsBoundary')).toEqual([]);
  });

  it('🔴 Put の Deny は「我々の境界 ARN 以外」に限定されている（弱いものへ差し替えさせない）', () => {
    const denies = conditionalDenies(boundary, 'iam:PutRolePermissionsBoundary');
    expect(denies.length).toBeGreaterThan(0);
    for (const s of denies) {
      expect(s.Condition?.StringNotEquals?.['iam:PermissionsBoundary']).toBe(BOUNDARY_ARN);
    }
  });

  it('🔴 cfn-exec が Put を「我々の境界のときだけ」Allow している', () => {
    const allows = cfnExec.Statement.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('iam:PutRolePermissionsBoundary'),
    );
    expect(allows.length).toBeGreaterThan(0);
    for (const s of allows) {
      expect(s.Condition?.StringEquals?.['iam:PermissionsBoundary']).toBe(BOUNDARY_ARN);
    }
  });

  /**
   * 🔴 **Permissions Boundary は denylist ではなく「天井」である。**
   * 実効権限は `identity policy ∩ boundary` なので、**boundary が Allow していない action は
   * identity policy が許しても実行時に 403 になる**（`no permissions boundary allows the ...`）。
   *
   * 2026-08-14 の 2 回目のデプロイはここで落ちた。1 回目の修正で `DenyBoundaryEscape` を
   * 条件付きへ直したが、boundary 側の **Allow を足し忘れた**ため
   * 「Deny には当たらないが Allow も無い」状態になっていた。
   * Deny を直したら Allow も対で確かめること。
   */
  it('🔴 boundary 自身も Put を「我々の境界のときだけ」Allow している（天井に無い action は通らない）', () => {
    const allows = boundary.Statement.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('iam:PutRolePermissionsBoundary'),
    );
    expect(allows.length).toBeGreaterThan(0);
    for (const s of allows) {
      expect(s.Condition?.StringEquals?.['iam:PermissionsBoundary']).toBe(BOUNDARY_ARN);
    }
  });

  it('🔴 boundary は Delete を Allow していない（天井にも外す経路を作らない）', () => {
    const allows = boundary.Statement.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('iam:DeleteRolePermissionsBoundary'),
    );
    expect(allows).toEqual([]);
  });

  it('🔴 cfn-exec は Delete を Allow していない（外す経路を作らない）', () => {
    const allows = cfnExec.Statement.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('iam:DeleteRolePermissionsBoundary'),
    );
    expect(allows).toEqual([]);
  });

  it('boundary は IAM の 6144 文字上限に収まる', () => {
    expect(JSON.stringify(boundary).length).toBeLessThanOrEqual(6144);
  });
});

/**
 * 🔴 **天井はランタイムにも効く（2026-08-15 のインシデント）。**
 *
 * boundary はアプリが作る実行ロールにも付くので、**dev の Lambda が実行時に必要とする
 * 読み取りが天井に無いと、デプロイは成功するのに機能だけ壊れる**。
 * #194 で app secret が Secrets Manager へ移ったのに天井が追随しておらず、
 * `secretsmanager:*` を丸ごと Deny していたため ServerFn が起動時に secret を読めず
 * fail-closed で中断し、dev が 500 になった。
 *
 * 直し方は「Deny を消す」ではなく「**Deny を自分の名前空間の外に絞り、
 * 中では読み取りだけを Allow する**」。破壊系（削除・書き換え）は名前空間の中でも
 * Allow していないので implicit deny のまま止まる。
 */
describe('dev ランタイムが必要とする読み取りが天井にある (#680 / 2026-08-15)', () => {
  const boundary = load('claude-boundary.json');
  const DEV_SECRETS = 'arn:aws:secretsmanager:*:822063948773:secret:open-reception/dev/*';

  const actionsOf = (s: PolicyStatement): ReadonlyArray<string> =>
    typeof s.Action === 'string' ? [s.Action] : (s.Action ?? []);
  const resourcesOf = (s: PolicyStatement): ReadonlyArray<string> =>
    typeof s.Resource === 'string' ? [s.Resource] : (s.Resource ?? []);

  it('🔴 dev の app secret を読める（GetSecretValue が天井にある）', () => {
    const allows = boundary.Statement.filter(
      (s) => s.Effect === 'Allow' && actionsOf(s).includes('secretsmanager:GetSecretValue'),
    );
    expect(allows.length).toBeGreaterThan(0);
    // `Resource:"*"` で通すと他プロジェクトの secret まで読めてしまう。
    for (const s of allows) {
      expect(resourcesOf(s)).toContain(DEV_SECRETS);
      expect(resourcesOf(s)).not.toContain('*');
    }
  });

  it('🔴 dev 名前空間の外の secret は Deny のまま', () => {
    const denies = boundary.Statement.filter(
      (s) => s.Effect === 'Deny' && actionsOf(s).includes('secretsmanager:*'),
    );
    expect(denies.length).toBeGreaterThan(0);
    // NotResource で「dev 以外すべて」を Deny する形にしていること。
    for (const s of denies) {
      const notResource = typeof s.NotResource === 'string' ? [s.NotResource] : (s.NotResource ?? []);
      expect(notResource).toContain(DEV_SECRETS);
    }
  });

  it('🔴 dev 名前空間の中でも破壊系は Allow していない（implicit deny のまま）', () => {
    const destructive = [
      'secretsmanager:DeleteSecret',
      'secretsmanager:PutSecretValue',
      'secretsmanager:UpdateSecret',
      'secretsmanager:PutResourcePolicy',
    ];
    for (const action of destructive) {
      const allows = boundary.Statement.filter(
        (s) =>
          s.Effect === 'Allow' &&
          (actionsOf(s).includes(action) || actionsOf(s).includes('secretsmanager:*')),
      );
      expect(allows, `${action} を Allow している文がある`).toEqual([]);
    }
  });

  /**
   * 6144 文字上限に収めるため `iam:UpdateAssumeRolePolicy` の**重複掲載**を外した。
   * 実効的な禁止は落ちていない ―― `Resource:"*"` の無条件 Deny が 1 本あり、
   * それがすべてを覆うため。スコープ付き Deny への再掲は文字数を食うだけだった。
   * **この前提が崩れたら（無条件 Deny が消えたら）ここで落ちる。**
   */
  it('🔴 iam:UpdateAssumeRolePolicy は無条件・Resource:* で Deny されている（重複を外した根拠）', () => {
    const blanket = boundary.Statement.filter(
      (s) =>
        s.Effect === 'Deny' &&
        actionsOf(s).includes('iam:UpdateAssumeRolePolicy') &&
        s.Resource === '*' &&
        s.Condition === undefined,
    );
    expect(blanket.length).toBeGreaterThan(0);
  });

  /**
   * 6144 文字上限に収めるため、共有 bootstrap の Deny 資源を
   * `role/cdk-hnb659fds-*` + `policy/cdk-hnb659fds-*` の 2 本から
   * `*\/cdk-hnb659fds-*` の 1 本へ畳んだ（staging も同様）。
   *
   * **Deny が覆う範囲は減っていない。むしろ増えている**（`instance-profile/` など
   * 他の資源型にも及ぶ）。ここでは畳んだあとも元の 2 つを実際に覆うことを固定する。
   */
  it.each([
    ['arn:aws:iam::822063948773:role/cdk-hnb659fds-deploy-role-822063948773-ap-northeast-1'],
    ['arn:aws:iam::822063948773:policy/cdk-hnb659fds-something'],
    ['arn:aws:iam::822063948773:role/cdk-staging-deploy-role-822063948773-ap-northeast-1'],
    ['arn:aws:iam::822063948773:policy/cdk-staging-something'],
  ])('🔴 %s は依然として Deny の資源に一致する', (arn) => {
    const patterns = boundary.Statement.filter(
      (s) => s.Effect === 'Deny' && actionsOf(s).includes('iam:PutRolePolicy'),
    ).flatMap((s) => resourcesOf(s));
    expect(patterns.some((p) => iamArnGlobMatches(p, arn)), `どの Deny 資源にも一致しない: ${arn}`).toBe(
      true,
    );
  });

  /**
   * 🔴 **IAM 自身の検証規則に通ることまで見る（2026-08-15 にすり抜けた層）。**
   *
   * 6144 文字に収めるため `role/cdk-hnb659fds-*` + `policy/cdk-hnb659fds-*` を
   * `*` + `/cdk-hnb659fds-*` へ畳んだところ、構造テストも被覆テストも通ったのに
   * **`create-policy-version` が `MalformedPolicyDocument` で落ちた**:
   *
   * > IAM resource path must either be "*", root, or start with user/, federated-user/,
   * > role/, group/, instance-profile/, mfa/, server-certificate/, policy/, ...
   *
   * 「テストは通るが AWS が受け取らない」ポリシーを二度と出さないために固定する。
   */
  it('🔴 すべての IAM 資源 ARN が IAM の許すパスで始まる（AWS が受け取れる形）', () => {
    const VALID_PREFIXES = [
      'user/',
      'federated-user/',
      'role/',
      'group/',
      'instance-profile/',
      'mfa/',
      'server-certificate/',
      'policy/',
      'sms-mfa/',
      'saml-provider/',
      'oidc-provider/',
      'report/',
      'access-report/',
    ];
    const iamArns = boundary.Statement.flatMap((s) => [
      ...(typeof s.Resource === 'string' ? [s.Resource] : (s.Resource ?? [])),
      ...(typeof s.NotResource === 'string' ? [s.NotResource] : (s.NotResource ?? [])),
    ]).filter((arn) => arn.startsWith('arn:aws:iam:'));
    expect(iamArns.length).toBeGreaterThan(0);
    for (const arn of iamArns) {
      // `arn:aws:iam::<account>:<path>` の <path> 部分を取り出す。
      const path = arn.split(':').slice(5).join(':');
      const ok = path === '*' || path === 'root' || VALID_PREFIXES.some((p) => path.startsWith(p));
      expect(ok, `IAM が受け取らない資源パス: ${arn}`).toBe(true);
    }
  });

  it('KMS の破壊系は引き続き Deny されている（分割で落とさない）', () => {
    const denied = auditPolicyDocument(boundary).deniedActions;
    for (const a of ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy']) {
      expect(denied).toContain(a);
    }
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
  //
  // 🔴 **訂正（2026-08-13、`cdk deploy --no-execute` の実 API 実測。ADR 0009 決定 2）:
  // `cloudformation:DescribeChangeSet` は changeSet ではなく stack リソースタイプに
  // 対して認可される。** 実際の `AccessDenied` は
  // `resource: arn:...:stack/OpenReception-Web-dev/<id>` を名指しした（changeSet ARN
  // ではない）。旧実装は AWS Service Authorization Reference の読解だけを根拠に
  // `DescribeChangeSet` を別ステートメント（`ReadOwnChangeSetsForDiffGate`、changeSet
  // ARN スコープ）へ分離していたが、これは実 API の動作と食い違っていた
  // （`run_diff_gate` の `describe-change-set` が構造的に Deny され続けていたはず）。
  // `DescribeChangeSet` を本ステートメントへ統合し、`ReadOwnChangeSetsForDiffGate` は
  // 一度も実際の権限として機能していなかった（entry role がこのアクションを呼ぶ経路は
  // 常に stack ARN でしか評価されない）死んだステートメントとして削除した。
  it('read-only 診断用 Allow (ReadOwnDevStacksForDiffGate) は OpenReception-*-dev の CloudFormation だけを対象にしている（DescribeStacks と DescribeChangeSet の両方）', () => {
    const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
      v === undefined ? [] : typeof v === 'string' ? [v] : v;
    const stmt = doc.Statement.find(
      (s) => s.Effect === 'Allow' && list(s.Action).includes('cloudformation:DescribeStacks'),
    );
    expect(stmt).toBeDefined();
    // 🔴 DescribeChangeSet は別ステートメントに分離せず、同じ stack ARN Allow に含める
    // （changeSet ARN スコープの `ReadOwnChangeSetsForDiffGate` は削除済み。上のコメント参照）。
    expect(list(stmt!.Action)).toContain('cloudformation:DescribeChangeSet');
    const resources = list(stmt!.Resource);
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(r).toMatch(/^arn:aws:cloudformation:[a-z0-9-]+:822063948773:stack\/OpenReception-[A-Za-z0-9]+-dev\/\*$/);
    }
    // 他プロジェクト・他環境・changeSet ARN が紛れ込んでいないことも明示的に確認する。
    const joined = resources.join('\n');
    for (const foreign of ['nodi-', 'salon-loop-', '-prod/', '-staging/', 'changeSet/']) {
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
    expect(patterns).toContain('stack/OpenReception-CfMon-dev/');
    expect(patterns).toContain('stack/CDKToolkit-orcloud01/');
  });

  it('NotResource 許可リストにワイルドカード単体を含まない（主境界を無効化する）', () => {
    expect(audit.deniedNotResourcePatterns).not.toContain('*');
    for (const p of audit.deniedNotResourcePatterns) {
      expect(p).toMatch(/^arn:aws:cloudformation:/);
    }
  });

  // Important A（2026-08-12 レビュー。2026-08-13 / 2026-08-15 の実 API 実測で 2 度訂正）:
  // このファイルは deploy role（`cdk-orcloud01-*`）に上乗せする Deny。`cloudformation:*` の
  // Deny を `NotResource`（許可リスト）で除外している。
  //
  // 🔴 **CloudFormation の change set 系アクションは 3 つとも stack リソースタイプに対して
  // 認可される。`changeSet` ARN スコープの許可エントリは一致し得ない＝死んでいる。**
  //
  // 2026-08-13 に `DescribeChangeSet` だけがそうだと分かった（`cdk deploy --no-execute` の
  // `AccessDenied` が stack ARN を名指し。ADR 0009 決定 2）。このとき
  // `ExecuteChangeSet` / `DeleteChangeSet` は「deploy 段でしか呼ばれず未証明」として
  // changeSet ARN の許可エントリを予防的に残した。
  //
  // 2026-08-15 に runbook ステップ 4b を実施して**残り 2 つも測った**。
  // `simulate-custom-policy` に**無関係の最小 Allow**（`{Effect: Allow, Action: <act>,
  // Resource: "*"}`）を渡して同じ ARN を評価させた結果:
  //
  // | action | changeSet ARN | stack ARN |
  // | --- | --- | --- |
  // | `ExecuteChangeSet` | `implicitDeny` | `allowed` |
  // | `DeleteChangeSet`  | `implicitDeny` | `allowed` |
  // | `DescribeChangeSet`| `implicitDeny` | `allowed` |
  //
  // **`Resource: "*"` ですら changeSet ARN に一致しない**＝リソースタイプが違う。
  // よって `changeSet/claude-gate-*/*` の 2 エントリは何も許可しておらず、
  // 「`claude-gate-*` 以外の change set 名は Deny される」という runbook 4b の 9 番は
  // **偽 PASS** だった（名前 allowlist が効いたのではなく、資源型が一致しないので
  // 常に `implicitDeny` になっていただけ）。
  //
  // 🔴 **inert なだけでなく latent な穴でもある。** `NotResource` は Deny からの
  // 除外リストなので、将来 AWS が changeSet ARN での認可を導入したら、
  // **他プロジェクトのスタック上の** `claude-gate-*` という名前の change set まで
  // 主境界の Deny を素通りする。実効権限は deploy role の実ポリシー側（stack ARN で
  // `ExecuteChangeSet`/`DeleteChangeSet` とも `allowed` を実測済み）で足りているので、
  // 消して困るものは無い。
  it('NotResource 許可リストの各エントリは stack ARN である（changeSet ARN は資源型が一致せず死んでいる）', () => {
    const stackOnly =
      /^arn:aws:cloudformation:[a-z0-9-]+:822063948773:stack\/(OpenReception-[A-Za-z0-9]+-dev|CDKToolkit-orcloud01)\/\*$/;
    expect(audit.deniedNotResourcePatterns.length).toBeGreaterThan(0);
    for (const p of audit.deniedNotResourcePatterns) {
      expect(p).toMatch(stackOnly);
    }
    const joined = audit.deniedNotResourcePatterns.join('\n');
    for (const foreign of ['nodi-', 'salon-loop-', 'Kiaff', '-prod/', '-staging/']) {
      expect(joined).not.toContain(foreign);
    }
  });

  // 上のテストは「各エントリが stack ARN の形をしている」ことしか言わない。`changeSet`
  // という語がこのファイルのどこか別の場所（Deny 側の `Resource` など）に紛れ込んでも
  // 落ちないので、**ファイル全体に対する禁止**を別のアサーションとして置く。
  it('ファイル全体のどこにも changeSet ARN スコープを含まない', () => {
    const raw = readFileSync(
      resolve(process.cwd(), 'scripts/aws-policies/claude-deploy-role-restriction.json'),
      'utf8',
    );
    expect(raw).not.toContain(':changeSet/');
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

    /**
     * 🔴 **#680 続報: 4 本目（BucketDeployment）で `s3:` アクションが加わり、
     * 「6 つの `ssm:` アクション」という単一プレフィックスの表現が偽になった。**
     * 総数だけでなく、`ssm:` / `s3:` それぞれの内訳もコードから引いて文書と突き合わせる
     * （手で書いた数字は書いた瞬間に腐る）。
     */
    it.each([SPEC, RUNBOOK])('%s が許可リストの本数（ssm/s3 の内訳込み）を正しく書いている', (doc) => {
      const all = [...CARVE_OUT_ALLOWED_ACTIONS];
      const ssmCount = all.filter((a) => a.startsWith('ssm:')).length;
      const s3Count = all.filter((a) => a.startsWith('s3:')).length;
      expect(ssmCount + s3Count).toBe(all.length);
      expect(ssmCount).toBeGreaterThan(0);
      expect(s3Count).toBeGreaterThan(0);
      const text = normalize(readDoc(doc));
      expect(text).toContain(normalize(`${all.length} 個`));
      expect(text).toContain(normalize(`\`ssm:\` が ${ssmCount} 個`));
      expect(text).toContain(normalize(`\`s3:\` が ${s3Count} 個`));
    });

    it('許可リストは ssm: と s3: だけで構成されている（4 本の carve-out ロールの実測どおり）', () => {
      expect(
        [...CARVE_OUT_ALLOWED_ACTIONS].filter((a) => !a.startsWith('ssm:') && !a.startsWith('s3:')),
      ).toEqual([]);
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
