/**
 * IAM ポリシー JSON の構造検証 (spec §11)。
 *
 * 副作用なし。**これは網であって証明ではない** — 「書き忘れ」と「明らかな穴」を
 * 機械で押さえるだけで、実際に DENY されるかは `SimulatePrincipalPolicy` が確かめる
 * （`scripts/aws-negative-tests.ts`）。両方揃って初めて spec §9 を満たす。
 *
 * `NotResource` は `Resource` と別集計にしている。`Resource` を使う Deny は列挙リスト
 * （書き漏れがあると**狭すぎて**穴になる）だが、`NotResource` を使う Deny は許可の
 * allowlist（書き間違い・`*` 混入があると**広すぎて**主境界が丸ごと無効化する）——
 * 失敗の向きが逆なので、同じ配列に混ぜて集計すると片方の異常がもう片方の異常に
 * 埋もれて見えなくなる。
 */

export type PolicyStatement = {
  readonly Effect: 'Allow' | 'Deny';
  readonly Action?: string | ReadonlyArray<string>;
  readonly NotAction?: string | ReadonlyArray<string>;
  readonly Resource?: string | ReadonlyArray<string>;
  readonly NotResource?: string | ReadonlyArray<string>;
  readonly Principal?: unknown;
  readonly Condition?: Record<string, Record<string, string | ReadonlyArray<string>>>;
};

export type PolicyDocument = {
  readonly Version: string;
  readonly Statement: ReadonlyArray<PolicyStatement>;
};

export type PolicyAudit = {
  /** Allow かつ Action:* かつ Resource:* を含むか。 */
  readonly grantsAdmin: boolean;
  /** PermissionsBoundary 条件の無い `iam:CreateRole` の Allow を含むか。 */
  readonly unboundedRoleCreation: boolean;
  /**
   * PermissionsBoundary 条件の無い `iam:CreateRole` Allow の **Resource パターン**。
   *
   * 🔴 出荷しているポリシーには**意図的な例外が 1 つある**（#680 R1）。CDK の
   * `CustomResourceProvider`（`crossRegionReferences` / `autoDeleteObjects`）が吐く
   * 生の `AWS::IAM::Role` には Aspect が届かず boundary が付かないため、その名前
   * パターンだけを carve-out してある。よって「boundary 無し CreateRole が**無い**」は
   * もう主張できない ―― 代わりに「**どの Resource に対して**例外を認めたか」を
   * 見えるようにして、テストが `*` や `role/*` への拡大を検出できるようにする。
   */
  readonly unboundedRoleCreationResources: ReadonlyArray<string>;
  readonly deniedActions: ReadonlyArray<string>;
  /**
   * Allow ステートメントに現れるアクション。
   *
   * Permissions Boundary は**天井**なので、ここに無いアクションは、そのロールの
   * identity policy がいくら許可していても実行時に効かない。`deniedActions` だけを
   * 見ていると「Deny が足りているか」しか分からず、「必要なものが足りているか」を
   * 見落とす（例: dev の server Lambda が使う `ce:GetCostAndUsage`）。
   */
  readonly allowedActions: ReadonlyArray<string>;
  readonly deniedResourcePatterns: ReadonlyArray<string>;
  /** Deny ステートメントの `NotResource`（allowlist）に列挙された ARN パターン。 */
  readonly deniedNotResourcePatterns: ReadonlyArray<string>;
  readonly allowedResourcePatterns: ReadonlyArray<string>;
  /**
   * `iam:PassRole` を `Resource: "*"` で、**渡し先を絞る条件なしに** Allow しているか。
   *
   * 層 2 の安全性の主張は「広い grant は dev スタックのテンプレートが要求したときにしか
   * 行使されない」だった。しかしそのテンプレートを書くのは、脅威モデル（spec §3）が
   * 侵害を仮定している当のサンドボックスである。`Role.fromRoleArn('<lambda を信頼する
   * 既存の別ロール>')` を `lambda.Function` に渡す変更を足せば、change set 上は
   * `AWS::Lambda::Function` の `Add`（`SAFE_ACTION`）にしか見えず gate は止めも記録も
   * せず、その Lambda は Permissions Boundary の**外**で動く。
   *
   * 「絞る条件」と認めるのは `iam:PassedToService` または `aws:ResourceTag/*`。
   * `*IfExists` / `Null` 演算子は（キー欠如時に真になるので）認めない。
   */
  readonly unscopedPassRole: boolean;
  /**
   * 顧客管理ポリシーの中身を差し替えられる操作を `Resource: "*"` で Allow しているか。
   * `iam:CreatePolicyVersion --set-as-default` は他プロジェクトの実行ポリシーを
   * 丸ごと書き換えられる。
   */
  readonly unscopedPolicyRewrite: boolean;
  /**
   * ロールの破壊・信頼関係の書き換えを `Resource: "*"` で Allow しているか。
   * `iam:DeleteRole` on `cdk-hnb659fds-cfn-exec-role-*` は 4 プロジェクト全部の
   * デプロイを壊す。`iam:DeleteRolePolicy` on `cdk-orcloud01-deploy-role-*` は
   * 層 1（主境界）のインラインポリシーを剥がす。
   */
  readonly unscopedRoleWrite: boolean;
  /**
   * 上記の広い Allow を打ち消す **Deny 側**に列挙された ARN パターン。
   *
   * `unscopedPolicyRewrite` / `unscopedRoleWrite` は、出荷しているポリシーでは
   * 実際に true である（CDK が自分のロール・ポリシーを更新するために要る）。
   * したがって「false であること」ではなく「**広いなら、名前による明示 Deny が
   * 揃っていること**」を検査する必要がある。その材料。
   */
  readonly iamWriteDenyPatterns: ReadonlyArray<string>;
};

/** ポリシー差し替え系の昇格プリミティブ。 */
const POLICY_REWRITE_ACTIONS = [
  'iam:CreatePolicyVersion',
  'iam:SetDefaultPolicyVersion',
  'iam:DeletePolicyVersion',
  'iam:DeletePolicy',
] as const;

/** ロール破壊・信頼関係書き換え系の昇格プリミティブ。 */
const ROLE_WRITE_ACTIONS = [
  'iam:DeleteRole',
  'iam:DeleteRolePolicy',
  'iam:DetachRolePolicy',
  'iam:UpdateAssumeRolePolicy',
] as const;

/** Deny 側の集計対象（`iamWriteDenyPatterns`）。 */
const IAM_WRITE_ACTIONS: ReadonlyArray<string> = [
  ...POLICY_REWRITE_ACTIONS,
  ...ROLE_WRITE_ACTIONS,
  'iam:CreateRole',
  'iam:PutRolePolicy',
  'iam:AttachRolePolicy',
  'iam:CreatePolicy',
  'iam:PassRole',
];

const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  v === undefined ? [] : typeof v === 'string' ? [v] : v;

/**
 * `iam:PermissionsBoundary` 条件が付いているか。キー名は大小差を吸収する。
 *
 * **演算子も見る。キーが存在するだけでは不十分。** `...IfExists` 系の演算子は、
 * 対象 context key が存在しないリクエストに対して無条件で true を返す
 * （比較を試みない）。`iam:CreateRole` が boundary パラメータ無しで呼ばれた場合、
 * まさにそのケースが起きる——つまり `StringEqualsIfExists` は「boundary 条件が
 * 付いている」ように見えて実際には何も強制していない。`Null` 演算子も同様に
 * 危険で、`{ Null: { 'iam:PermissionsBoundary': 'true' } }` は「このキーが
 * **存在しない**こと」を主張できてしまう。どちらを許容すると、この直前の
 * コミットで塞いだのと同じ穴（lint は green だが実効性が無い）を検出器自身が
 * 再現する。よって演算子名が `ifexists` で終わるもの、および `null` は
 * boundary 条件として認めない。
 */
function hasBoundaryCondition(s: PolicyStatement): boolean {
  return strictConditionKeys(s).some((key) => key === 'iam:permissionsboundary');
}

/**
 * ステートメントの Condition のうち、**実効性のある演算子**で書かれたキーを小文字で返す。
 *
 * `...IfExists` 系は対象 context key が存在しないリクエストに対して無条件で true を返し、
 * `Null` 演算子は「キーが存在しないこと」を主張できてしまう。どちらも「条件が付いている
 * ように見えて何も強制していない」状態を作る。この判定は boundary 条件だけでなく
 * `sts:ExternalId`（trust policy）や `iam:PassedToService`（PassRole）でも同じなので、
 * 共通のヘルパにしてある。
 */
export function strictConditionKeys(s: PolicyStatement): ReadonlyArray<string> {
  if (s.Condition === undefined) return [];
  const keys: string[] = [];
  for (const [operator, values] of Object.entries(s.Condition)) {
    const op = operator.toLowerCase();
    if (op.endsWith('ifexists') || op === 'null') continue;
    for (const key of Object.keys(values)) keys.push(key.toLowerCase());
  }
  return keys;
}

/**
 * ステートメントの Condition に、指定キーを持つ**実効性のある**演算子の名前を返す。
 * trust policy の `sts:ExternalId` のように「演算子まで固定したい」テストが使う。
 */
export function conditionOperatorsForKey(s: PolicyStatement, conditionKey: string): ReadonlyArray<string> {
  if (s.Condition === undefined) return [];
  const wanted = conditionKey.toLowerCase();
  const operators: string[] = [];
  for (const [operator, values] of Object.entries(s.Condition)) {
    if (Object.keys(values).some((k) => k.toLowerCase() === wanted)) operators.push(operator);
  }
  return operators;
}

/** `iam:PassRole` の渡し先を絞る条件が付いているか。 */
function hasPassRoleScopingCondition(s: PolicyStatement): boolean {
  return strictConditionKeys(s).some(
    (key) => key === 'iam:passedtoservice' || key.startsWith('aws:resourcetag/'),
  );
}

const matchesAction = (actions: ReadonlyArray<string>, wanted: string): boolean =>
  actions.some((a) => a === wanted || a === '*' || (a.endsWith(':*') && wanted.startsWith(a.slice(0, -1))));

export function auditPolicyDocument(doc: PolicyDocument): PolicyAudit {
  let grantsAdmin = false;
  let unboundedRoleCreation = false;
  const unboundedRoleCreationResources: string[] = [];
  let unscopedPassRole = false;
  let unscopedPolicyRewrite = false;
  let unscopedRoleWrite = false;
  const deniedActions: string[] = [];
  const allowedActions: string[] = [];
  const deniedResourcePatterns: string[] = [];
  const deniedNotResourcePatterns: string[] = [];
  const allowedResourcePatterns: string[] = [];
  const iamWriteDenyPatterns: string[] = [];

  for (const s of doc.Statement) {
    const actions = list(s.Action);
    const resources = list(s.Resource);

    if (s.Effect === 'Deny') {
      deniedActions.push(...actions);
      deniedResourcePatterns.push(...resources);
      deniedNotResourcePatterns.push(...list(s.NotResource));
      if (IAM_WRITE_ACTIONS.some((a) => matchesAction(actions, a))) {
        iamWriteDenyPatterns.push(...resources);
      }
      continue;
    }

    allowedActions.push(...actions);
    allowedResourcePatterns.push(...resources);
    if (actions.includes('*') && resources.includes('*')) grantsAdmin = true;
    if (matchesAction(actions, 'iam:CreateRole') && !hasBoundaryCondition(s)) {
      unboundedRoleCreation = true;
      unboundedRoleCreationResources.push(...resources);
    }
    if (
      matchesAction(actions, 'iam:PassRole') &&
      resources.includes('*') &&
      !hasPassRoleScopingCondition(s)
    ) {
      unscopedPassRole = true;
    }
    if (resources.includes('*')) {
      if (POLICY_REWRITE_ACTIONS.some((a) => matchesAction(actions, a))) unscopedPolicyRewrite = true;
      if (ROLE_WRITE_ACTIONS.some((a) => matchesAction(actions, a))) unscopedRoleWrite = true;
    }
  }

  return {
    grantsAdmin,
    unboundedRoleCreation,
    unboundedRoleCreationResources,
    unscopedPassRole,
    unscopedPolicyRewrite,
    unscopedRoleWrite,
    deniedActions,
    allowedActions,
    deniedResourcePatterns,
    deniedNotResourcePatterns,
    allowedResourcePatterns,
    iamWriteDenyPatterns,
  };
}
