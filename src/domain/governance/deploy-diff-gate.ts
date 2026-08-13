/**
 * CloudFormation change set の危険判定 (spec §6)。
 *
 * 設計原則:
 *  - 副作用なし。`describe-change-set` の JSON から抜いた最小の形を**受け取る**だけで、
 *    自分で AWS を叩かない（呼び出し側が渡す。純関数のままテストできる）。
 *  - `cdk diff` のテキストを parse しない。取りこぼす。
 *
 * **止める側と記録だけの側を分けてある。** 一律停止にすると gate が恒常的に赤くなり、
 * 赤を無視する習慣がつく方が危険（`change-risk.ts` が report-only である理由と同じ）。
 * 普通の IAM Role / Policy の Add・Modify を止めないのは、exec role が作る Role に
 * Permissions Boundary が強制されるため（spec §4.2 層 4）。**差分レビューより強い保証**。
 *
 * 🔴 **ただし carve-out された名前空間には、その「より強い保証」が無い (#680 R10)。**
 * `CARVE_OUT_ROLE_ARN_PATTERN` に入るロールには boundary が掛からない。名前グロブでは
 * 防げない（論理 ID も `RoleName` も `Path` もテンプレートを書く側が決められる）ので、
 * **この名前空間に対してだけは gate が主たる制御である**。同じ理由で
 * `AWS::Lambda::Url` も止める —— 公開 HTTPS の入口は、デプロイ窓が閉じたあとも残る。
 * 詳細は `docs/runbook-cloud-aws-deploy.md` 4d。
 */

import {
  CARVE_OUT_ACCOUNT_ID,
  CARVE_OUT_ROLE_ARN_PATTERN,
  cfnGeneratedNamePrefix,
  iamArnGlobMatches,
  iamArnGlobMatchesGeneratedName,
} from './cfn-generated-name';

/** 自動デプロイを止める理由。 */
export const DEPLOY_BLOCK_REASONS = [
  'unexpectedStack',
  'resourceRemoval',
  'unknownAction',
  'resourceReplacement',
  'kmsChange',
  'secretsChange',
  'dnsOrCertificateChange',
  'networkBoundaryChange',
  'iamPrincipalChange',
  'carveOutRoleNamespace',
  'carveOutRoleShape',
  'roleTrustPolicyEscape',
  'functionUrlExposure',
  'publicInvokePermission',
  'opaqueResourceShape',
] as const;
export type DeployBlockReason = (typeof DEPLOY_BLOCK_REASONS)[number];

/** 止めないが記録する理由。 */
export const DEPLOY_FLAG_REASONS = ['iamPolicyChange', 'opaqueRoleTrustPolicy'] as const;
export type DeployFlagReason = (typeof DEPLOY_FLAG_REASONS)[number];

/**
 * 🔴 **CDK が生成し、我々が中身を確認したと「宣言」しているリソースの論理 ID。**
 *
 * ここへ 1 行足すことは便宜ではない。**「この論理 ID で現れるリソースは CDK が
 * 決定論的に生成するものであり、その中身をレビューした」という主張**であり、
 * 主張が誤っていれば gate は無害な名前で有害な実体を通す。
 *
 * だから追加するときは必ず (1) synth して論理 ID を実測し、(2) その実体の
 * プロパティを読み、(3) 下の形の固定（`assertCarveOutProviderShape` /
 * `AWS::Lambda::Url` の `AuthType`）が新しい実体にも当てはまることを確かめること。
 * **論理 ID の allowlist だけでは足りない** —— 論理 ID はテンプレートを書く側が
 * 自由に付けられるので、allowlist に載った ID を騙る実体を必ず形で弾く。
 *
 * 出所:
 *  - `carveOutProviderRoles` … `infra/test/claude-deploy-boundary.test.ts` の
 *    2 スタック 2 リージョン fixture を synth して実測した 3 本
 *  - `functionUrls` … `infra/lib/stacks/web-stack.ts` の `ServerFn` / `ImageFn` に
 *    対する `addFunctionUrl()`。論理 ID は構築パス（`<Fn>/FunctionUrl/Resource`）の
 *    md5 先頭 8 桁で決まり、コード資産の中身には依存しない
 *  - `publicInvokePermissions` … origin-verify 方式（`authType: NONE`）のとき CDK が
 *    自動で足す 2 本。`Principal: '*'` を持つのはこの 2 本**だけ**である
 *    （OAC 方式の Permission は `cloudfront.amazonaws.com`）
 *
 * 🔴 **URL と Permission は「論理 ID」ではなく「どの関数を指しているか」まで固定する。**
 * 初回デプロイでは全リソースが `Add` なので、**この論理 ID が本物の `ServerFn` /
 * `ImageFn` に付いていることを強制するものが他に無い**。`AuthType: NONE` の
 * `AWS::Lambda::Url` に allowlist 済みの論理 ID を付けて `TargetFunctionArn` だけ
 * 攻撃者の関数へ向ければ、名前だけの検査は素通りする。だから値は
 * **その URL / 許可が向いてよい Lambda 関数の論理 ID**にしてある。
 *
 * 関数側の論理 ID の出所も 2 通り（`CLAUDE.md`「調査の作法」）:
 *  1. synth 実測（`ServerFn4F3A536E` / `ImageFnCD541B83`）
 *  2. md5（`ServerFn/Resource` → `4F3A536E` / `ImageFn/Resource` → `CD541B83`）。
 *     論理 ID はスタック内の construct パスだけで決まる
 */
export const REVIEWED_CDK_GENERATED_LOGICAL_IDS = {
  carveOutProviderRoles: [
    'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
    'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
    'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
  ],
  /** Function URL の論理 ID → その URL が向いてよい Lambda 関数の論理 ID。 */
  functionUrls: {
    ServerFnFunctionUrlFFF9E3E1: 'ServerFn4F3A536E',
    ImageFnFunctionUrlBBD47D3E: 'ImageFnCD541B83',
  },
  /** `Principal:"*"` invoke 許可の論理 ID → その許可が向いてよい Lambda 関数の論理 ID。 */
  publicInvokePermissions: {
    ServerFninvokefunctionurl715820CF: 'ServerFn4F3A536E',
    ServerFninvokefunctionA3A7399A: 'ServerFn4F3A536E',
  },
} as const;

/** allowlist の写像を「未知のキーなら `undefined`」として引く。 */
function expectedTargetFunction(
  map: Readonly<Record<string, string>>,
  logicalId: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, logicalId) ? map[logicalId] : undefined;
}

/**
 * 「常に OAC + AWS_IAM」と決めてある Function URL の論理 ID (#631)。
 * server は origin-verify 方式で `NONE` になりうるが、image は**ならない** ——
 * image Lambda は middleware を通らず `x-origin-verify` を誰も検証しないので、
 * `NONE` にすると無認証・無検証の公開エンドポイントになる。
 */
const AWS_IAM_ONLY_FUNCTION_URL = 'ImageFnFunctionUrlBBD47D3E';

/**
 * carve-out されたロール（＝Permissions Boundary が掛からないロール）に載っていて
 * よい managed policy。CDK の `CustomResourceProvider` はこれ 1 本しか付けない
 * （synth で実測）。`AdministratorAccess` を足す経路をここで塞ぐ。
 */
const PROVIDER_MANAGED_POLICY_SUFFIX = ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

/** carve-out されたロールの trust policy が指してよい唯一の principal。 */
const PROVIDER_TRUST_SERVICE = 'lambda.amazonaws.com';

/** carve-out されたロールの trust policy が許してよい唯一の action。 */
const PROVIDER_TRUST_ACTION = 'sts:assumerole';

/**
 * carve-out されたロール（＝Permissions Boundary が掛からないロール）に載ってよい
 * action の**許可リスト**。ここに無い action は 1 つでもあれば止める。
 *
 * 🔴 **以前は「禁止する接頭辞」の否認リストだった。それは壊れていた**
 * （レビュー Blocking 2）。`lower.startsWith('iam:')` はコロン込みで比較するので、
 * `iam*` / `sts*` / `kms*` / `*:*` / `*:CreateRole` は**どれも素通り**する ——
 * どれも IAM が受け付ける正当な action 文字列で、指している操作は同じである。
 * ワイルドカードがサービス部分を跨げる以上、否認リストは列挙し切れない。
 *
 * **許可リストを選べるのは、通ってよい集合を実測できているから**である
 * （否認リストは「まだ思いついていない書き方」に対して常に負ける）。
 * 出所は in-process synth（`aws-cdk-lib` の `CustomResourceProvider` を
 * `crossRegionReferences` / `autoDeleteObjects` で生やした 2 スタック 2 リージョン）:
 *
 *  - `CustomCrossRegionExportWriter…` … `ssm:DeleteParameters` /
 *    `ssm:ListTagsForResource` / `ssm:GetParameters` / `ssm:PutParameter`
 *  - `CustomCrossRegionExportReader…` … `ssm:AddTagsToResource` /
 *    `ssm:RemoveTagsFromResource` / `ssm:GetParameters`
 *  - `CustomS3AutoDeleteObjects…` … **インラインポリシーを持たない**
 *    （バケット側のリソースポリシーで許可される）。`logs:` は managed policy
 *    （`AWSLambdaBasicExecutionRole`）側なのでここには現れない
 *
 * 外れ方の向き: CDK が action を増やすと**初回デプロイが gate で止まる**。
 * AccessDenied ではなく停止なので復旧は容易で、増えた action を人間が
 * 見てから足すことになる。逆向き（見落として通す）よりこちらが正しい。
 */
export const CARVE_OUT_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'ssm:deleteparameters',
  'ssm:listtagsforresource',
  'ssm:getparameters',
  'ssm:putparameter',
  'ssm:addtagstoresource',
  'ssm:removetagsfromresource',
]);

/**
 * carve-out のロールに載ってよい `Resource` の接頭辞（ARN のリソース部分）。
 *
 * 🔴 **action だけを許可リストにしても、`Resource: "*"` を許すと意味が薄い**
 * （2026-08-13 レビュー）。許可している 6 つは無害な名前に見えるが、
 * `ssm:DeleteParameters` を `*` で持つロールは**このアカウントの SSM パラメータを
 * 全部消せる** —— 静かで、アカウント全体で、他プロジェクトの設定が入っている。
 *
 * action と同じく **synth の実測**から取った。両 provider とも `Fn::Join` で
 * 次を組む（`Ref: AWS::Partition` を含む。リテラル ARN ではない）:
 *
 *  - Writer … `arn:${AWS::Partition}:ssm:us-east-1:822063948773:parameter/cdk/exports/*`
 *  - Reader … `arn:${AWS::Partition}:ssm:us-east-1:822063948773:parameter/cdk/exports/OpenReception-CfMonitoring-dev/*`
 *
 * 前者が後者を含むので、確認するのは **`parameter/cdk/exports/` の下**であること。
 */
export const CARVE_OUT_ALLOWED_RESOURCE_PREFIX = 'parameter/cdk/exports/';

/**
 * ARN のリージョン欄。**`*` を拒む**ためにパターンで確かめる。
 * 実測値は両 provider とも `us-east-1`（consumer スタックのリージョン）だが、
 * 安全性を担っているのは**アカウント欄とリソース接頭辞**であってリージョンではないので、
 * ここは「具体的なリージョンであること」までに留める（cross-region の相手が
 * 変わっただけで初回デプロイを止めない）。
 */
const CONCRETE_AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/**
 * その `Resource` が、実測した SSM の名前空間に**閉じている**か。
 *
 * `*` / `arn:aws:ssm:*:*:parameter/*` / `…:parameter/*` はいずれも false。
 * 解決できなかった部分は `UNRESOLVED_MARKER` になるので、どのフィールドとも一致しない。
 */
function isConfinedCarveOutResource(resolvedArn: string): boolean {
  const fields = resolvedArn.split(':');
  if (fields.length < 6) return false;
  if (fields[0] !== 'arn' || fields[1] !== 'aws' || fields[2] !== 'ssm') return false;
  if (!CONCRETE_AWS_REGION.test(fields[3] ?? '')) return false;
  if (fields[4] !== CARVE_OUT_ACCOUNT_ID) return false;
  return fields.slice(5).join(':').startsWith(CARVE_OUT_ALLOWED_RESOURCE_PREFIX);
}

/** `describe-change-set` の `Changes[].ResourceChange` から必要な項目だけ。 */
export type ChangeSetResourceChange = {
  /**
   * CloudFormation の変更操作。'Add' と 'Modify' だけが既知で安全。
   * 'Remove', 'Import', 'Dynamic' や将来の値は gate で止める（保守的に扱う）。
   * 既知の無害は Add と Modify のみ。他は詳細が判明するまで deploy を許可しない。
   */
  readonly action: string;
  readonly resourceType: string;
  readonly logicalResourceId: string;
  /** 'True' | 'False' | 'Conditional'。Modify のときのみ現れる。 */
  readonly replacement?: string;
};

/** synth 済みテンプレートの 1 リソースの `Properties`。 */
export type TemplateProperties = Readonly<Record<string, unknown>>;

/**
 * synth 済みテンプレートの 1 リソース。
 *
 * 🔴 **`Type` を落とさない。** `AWS::IAM::Policy` の `Roles: [{ Ref: X }]` を
 * 検査するには「X が本当に `AWS::IAM::Role` か」を知る必要がある。`Properties` だけ
 * 持っていると、`Ref` が**ロール以外**（例: `AWS::SSM::Parameter` の `Name` に
 * carve-out のロール名を書いたもの）を指していても「生成名を予測する」経路へ落ちて
 * carve-out の外だと誤判定する ―― 別リソース種別へ payload を移すだけで抜けられる。
 */
export type TemplateResource = {
  readonly type: string;
  readonly properties: TemplateProperties;
};

/** 論理 ID → リソース。`cdk.out/<stack>.template.json` の `Resources` から作る。 */
export type StackTemplateResources = Readonly<Record<string, TemplateResource>>;

export type ChangeSetSummary = {
  readonly stackName: string;
  readonly changes: ReadonlyArray<ChangeSetResourceChange>;
  /**
   * 🔴 **必須にしてある（optional にしない）。**
   *
   * `describe-change-set` は**プロパティの値を返さない**（変わった property の
   * *名前*しか返さない）。`RoleName` / `Path` / `AssumeRolePolicyDocument` /
   * `Principal` / `AuthType` はここからしか読めず、これらを読まない gate は
   * 「論理 ID が怪しくないので通す」しか言えない —— 論理 ID は**テンプレートを
   * 書く側が自由に決められる**ので、それは何も検査していないのと同じである。
   *
   * optional にすると「渡し忘れ = 検査なしで green」という最悪の既定になる。
   * 呼び出し側（`scripts/aws-diff-gate.ts`）はテンプレートを読めなければ非ゼロで終わる。
   */
  readonly templateResources: StackTemplateResources;
};

export type DeployBlock = { readonly reason: DeployBlockReason; readonly evidence: string };
export type DeployFlag = { readonly reason: DeployFlagReason; readonly evidence: string };

export type DeployGateVerdict = {
  readonly blocked: boolean;
  readonly blocks: ReadonlyArray<DeployBlock>;
  readonly flags: ReadonlyArray<DeployFlag>;
};

/**
 * 許可するスタック名。`bin/open-reception.ts` が `OpenReception-<Stack>-<env>` を
 * 決定論的に付ける。**末尾を固定する**（`-dev-extra` を通さない）。
 */
export const ALLOWED_STACK_PATTERN = /^OpenReception-[A-Za-z0-9]+-dev$/;

/** dev スタックが作る正当な理由が無い IAM プリンシパル。 */
const IAM_PRINCIPAL_TYPES = new Set([
  'AWS::IAM::User',
  'AWS::IAM::AccessKey',
  'AWS::IAM::Group',
  'AWS::IAM::UserToGroupAddition',
]);

/** 種別だけで止めるもの（Add でも止める。dev に存在しないため出現自体が想定外）。 */
const BLOCKED_TYPE_PREFIXES: ReadonlyArray<[string, DeployBlockReason]> = [
  ['AWS::KMS::', 'kmsChange'],
  ['AWS::SecretsManager::', 'secretsChange'],
  ['AWS::Route53::', 'dnsOrCertificateChange'],
  ['AWS::CertificateManager::', 'dnsOrCertificateChange'],
  ['AWS::EC2::SecurityGroup', 'networkBoundaryChange'],
];

/**
 * deploy で許可する action。これら以外（Remove, Import, Dynamic, 未知の値）は
 * 詳細が判明するまで保守的に stop する。
 *  - 'Add': リソース新規作成。仕様が明確。
 *  - 'Modify': リソース更新。replacement フィールドで置き換え判定。
 */
const SAFE_ACTIONS = new Set(['Add', 'Modify']);

/**
 * 権限を**別リソースとして**ロールへ足す 3 つの綴り。
 * `AWS::IAM::Policy`（インライン）/ `ManagedPolicy`（アタッチ）/ `RolePolicy`（インライン）は
 * 名前も形も違うが、carve-out のロールに対しては**同じ結果**をもたらす。
 */
const POLICY_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::RolePolicy',
]);

/** テンプレートの実体まで見て判定するリソース種別。 */
const WATCHED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Role',
  'AWS::Lambda::Url',
  'AWS::Lambda::Permission',
  ...POLICY_ATTACHMENT_TYPES,
]);

const describeChange = (c: ChangeSetResourceChange): string =>
  `${c.logicalResourceId} (${c.resourceType}) action=${c.action} replacement=${c.replacement ?? '-'}`;

// ---------------------------------------------------------------------------
// #680 R10: carve-out を diff gate で制動する
//
// carve-out（`CARVE_OUT_ROLE_ARN_PATTERN`）は Permissions Boundary の強制を名前で
// 外している。名前グロブは**テンプレートを書く側が論理 ID を選べる**以上そこを守れない
// ので、実際に止めるのはここ ―― change set は「何がどう作られるか」を、
// **1 バイトも AWS に適用される前に**見せてくれる。
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 論理 ID でテンプレートを引く。**プロトタイプ由来のキー**（`constructor` など）で
 * 「存在する」ことにしないよう `hasOwnProperty` で確かめる。
 */
function lookupResource(
  resources: StackTemplateResources,
  logicalId: string,
): TemplateResource | undefined {
  return Object.prototype.hasOwnProperty.call(resources, logicalId)
    ? resources[logicalId]
    : undefined;
}

/** `string | string[]` を配列に均す。それ以外は `null`（＝判定不能）。 */
function asStringList(v: unknown): ReadonlyArray<string> | null {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return v as ReadonlyArray<string>;
  return null;
}

/** ロールの物理名（と ARN）の解決結果。**判定不能を「安全」に丸めない**。 */
type RoleArnResolution =
  | { readonly kind: 'exact'; readonly arn: string }
  | { readonly kind: 'generated'; readonly arnPrefix: string }
  | { readonly kind: 'opaque'; readonly detail: string };

/**
 * その `AWS::IAM::Role` が持つことになる ARN を、**IAM が見るとおりに**組み立てる。
 *
 * 3 つの経路がある:
 *  - `RoleName` を明示 → その名前がそのまま物理名になる（切り詰めは起きない）
 *  - 明示しない → `<stack>-<論理 ID 切り詰め>-<12 文字の乱数>`
 *  - `Path` を指定 → ARN は `role/<path なしの先頭 / を除いた path><name>` になる。
 *    IAM のリソース ARN グロブでは `*` が `/` を跨ぐので、`Path` を
 *    `/OpenReception-x-dev-Custom/` などにするだけで carve-out の名前空間に入る。
 *    **人間が名前を眺めて気づける形ではない。**
 */
function resolveRoleArn(
  stackName: string,
  logicalId: string,
  props: TemplateProperties,
): RoleArnResolution {
  const rawPath = props.Path;
  if (rawPath !== undefined && typeof rawPath !== 'string') {
    return { kind: 'opaque', detail: 'Path が文字列リテラルではない（組み込み関数）' };
  }
  const path = rawPath ?? '/';
  if (!path.startsWith('/') || !path.endsWith('/')) {
    return { kind: 'opaque', detail: `Path の形が IAM の規約に合わない: ${path}` };
  }
  const arnBase = `arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:role${path}`;

  const rawName = props.RoleName;
  if (rawName !== undefined) {
    if (typeof rawName !== 'string') {
      return { kind: 'opaque', detail: 'RoleName が文字列リテラルではない（組み込み関数）' };
    }
    return { kind: 'exact', arn: `${arnBase}${rawName}` };
  }

  try {
    return { kind: 'generated', arnPrefix: `${arnBase}${cfnGeneratedNamePrefix(stackName, logicalId)}` };
  } catch (e) {
    return { kind: 'opaque', detail: (e as Error).message };
  }
}

type TrustVerdict =
  | {
      readonly kind: 'serviceOnly';
      readonly services: ReadonlyArray<string>;
      /**
       * Allow 側の statement に現れた action（小文字）。**`Principal` だけを見て
       * `Action` を見ないと、`lambda.amazonaws.com` を信頼したまま
       * `sts:AssumeRoleWithWebIdentity` を許すロールが通る**（レビュー指摘）。
       * carve-out の外では CDK が `sts:TagSession` 等を足すことがあるので、
       * この値を**強制するのは carve-out の中だけ**にしてある。
       */
      readonly actions: ReadonlyArray<string>;
    }
  | { readonly kind: 'external'; readonly detail: string }
  | { readonly kind: 'opaque'; readonly detail: string };

/**
 * trust policy（`AssumeRolePolicyDocument`）を分類する。
 *
 * 🔴 **IAM には trust policy の中身を縛る条件キーが無い。** boundary もタグ条件も
 * 「誰がこのロールになれるか」には一切効かない。だから外部アカウントや `"AWS":"*"` を
 * 信頼するロールは、**デプロイ窓が閉じたあとも外から assume できる**。
 * ここが唯一それを見られる場所である。
 */
function classifyTrustPolicy(doc: unknown): TrustVerdict {
  if (!isRecord(doc)) return { kind: 'opaque', detail: 'AssumeRolePolicyDocument がオブジェクトでない' };
  const statements = doc.Statement;
  if (!Array.isArray(statements)) return { kind: 'opaque', detail: 'Statement が配列でない' };

  const services: string[] = [];
  const actions: string[] = [];
  let opaque: string | null = null;

  for (const raw of statements) {
    if (!isRecord(raw)) return { kind: 'opaque', detail: 'Statement の要素がオブジェクトでない' };
    // Deny は権限を与えないので、信頼先の判定には効かない。
    if (raw.Effect === 'Deny') continue;

    const statementActions = asStringList(raw.Action);
    if (statementActions === null) {
      opaque ??= 'trust policy の Action が文字列リテラルでない';
    } else {
      actions.push(...statementActions.map((a) => a.toLowerCase()));
    }

    const principal = raw.Principal;
    if (principal === '*') return { kind: 'external', detail: 'Principal: "*"（誰でも assume できる）' };
    if (!isRecord(principal)) {
      opaque ??= 'Principal がオブジェクトでも "*" でもない';
      continue;
    }
    for (const [key, value] of Object.entries(principal)) {
      if (key === 'Service') {
        const list = asStringList(value);
        if (list === null) {
          opaque ??= 'Principal.Service が文字列リテラルでない（組み込み関数）';
          continue;
        }
        services.push(...list);
        continue;
      }
      if (key === 'AWS') {
        const list = asStringList(value);
        if (list === null) {
          // CDK は自アカウントの ARN を Fn::Join で組む。外部アカウントかを断定できない。
          opaque ??= 'Principal.AWS が文字列リテラルでない（組み込み関数）';
          continue;
        }
        for (const entry of list) {
          if (entry === '*') return { kind: 'external', detail: 'Principal.AWS: "*"' };
          const account = /^(?:arn:aws:(?:iam|sts)::)?(\d{12})(?::|$)/.exec(entry)?.[1];
          if (account === undefined) {
            opaque ??= `Principal.AWS からアカウントを読み取れない: ${entry}`;
            continue;
          }
          if (account !== CARVE_OUT_ACCOUNT_ID) {
            return { kind: 'external', detail: `Principal.AWS が別アカウント: ${entry}` };
          }
        }
        continue;
      }
      // Federated / CanonicalUser など。いずれもアカウント外から assume されうる。
      return { kind: 'external', detail: `Principal.${key} は外部からの assume を許す` };
    }
  }

  if (opaque !== null) return { kind: 'opaque', detail: opaque };
  return { kind: 'serviceOnly', services, actions };
}

/** managed policy ARN のリテラル表現を取り出す（`Fn::Sub` の文字列形も許す）。 */
function managedPolicyArnLiteral(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (isRecord(v) && typeof v['Fn::Sub'] === 'string') return v['Fn::Sub'];
  return null;
}

/**
 * ポリシーの Allow 側 statement を、**action と resource を対にしたまま**集める。
 *
 * 🔴 **action だけを平らに集めない。** 平らにすると「許可された action」と
 * 「広い `Resource`」が別々の statement に見えて、対で評価できない。
 */
type AllowStatement = {
  readonly actions: ReadonlyArray<string>;
  readonly resources: ReadonlyArray<unknown>;
};

/** 1 つの `PolicyDocument` の Allow statement を集める。読めなければ `null`。 */
function collectPolicyDocumentStatements(doc: unknown): ReadonlyArray<AllowStatement> | null {
  if (!isRecord(doc) || !Array.isArray(doc.Statement)) return null;
  const out: AllowStatement[] = [];
  for (const stmt of doc.Statement) {
    if (!isRecord(stmt)) return null;
    if (stmt.Effect === 'Deny') continue;
    // `NotAction` / `NotResource` は「これ以外すべて」＝ carve-out では必ず許可外を含む。
    if (stmt.NotAction !== undefined || stmt.NotResource !== undefined) return null;
    const actions = asStringList(stmt.Action);
    if (actions === null) return null;
    // `Resource` が無い Allow は IAM 的には不正だが、**無いことを「無害」にしない** ——
    // `[undefined]` として下流の解決に渡し、`UNRESOLVED_MARKER` になって停止する。
    // （専用の早期 return は置かない。同じ結果を返す枝は変異で区別できず、
    //   「一度も落ちたことのない分岐」になる。変異ドリル R5 で確認した）
    out.push({
      actions,
      resources: Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource],
    });
  }
  return out;
}

/** インラインポリシー（`Policies`）の Allow statement を集める。読めなければ `null`。 */
function collectInlineStatements(policies: unknown): ReadonlyArray<AllowStatement> | null {
  if (policies === undefined) return [];
  if (!Array.isArray(policies)) return null;
  const out: AllowStatement[] = [];
  for (const policy of policies) {
    if (!isRecord(policy)) return null;
    const statements = collectPolicyDocumentStatements(policy.PolicyDocument);
    if (statements === null) return null;
    out.push(...statements);
  }
  return out;
}

/**
 * carve-out のロールに載る statement のうち、許可リストから外れているものを述べる。
 *
 * action は**名前**の許可リスト（`*` を含む書き方は素の文字列比較で自動的に外れる ——
 * `iam*` も `*:*` も許可リストのどの項目とも一致しない）、`Resource` は
 * **実測した SSM の名前空間**に閉じていること。`Condition` は見ない ——
 * condition は権限を**狭める**方向にしか働かないので、無視しても安全側である。
 */
function carveOutStatementViolations(
  statements: ReadonlyArray<AllowStatement>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const stmt of statements) {
    for (const action of stmt.actions) {
      if (!CARVE_OUT_ALLOWED_ACTIONS.has(action.toLowerCase())) {
        violations.push(`許可リストに無い action: ${action}`);
      }
    }
    for (const resource of stmt.resources) {
      const resolved = resolveTemplateString(resource);
      if (!isConfinedCarveOutResource(resolved)) {
        violations.push(
          `許可リストの外の Resource: ${resolved}` +
            `（${CARVE_OUT_ALLOWED_RESOURCE_PREFIX} の下に閉じている必要があります）`,
        );
      }
    }
  }
  return violations;
}

/**
 * carve-out の名前空間に入るロールが、**CDK の provider role の形そのものか**を確かめる。
 *
 * 論理 ID の allowlist だけでは足りない理由がこれ: allowlist に載った論理 ID を
 * 名乗りつつ、trust policy を外部アカウントへ向け、インラインで `iam:*` を積む
 * テンプレートは簡単に書ける。**名前ではなく中身を固定する。**
 */
function carveOutShapeViolations(props: TemplateProperties): ReadonlyArray<string> {
  const violations: string[] = [];

  const trust = classifyTrustPolicy(props.AssumeRolePolicyDocument);
  if (trust.kind !== 'serviceOnly') {
    violations.push(`trust policy: ${trust.detail}`);
  } else {
    if (trust.services.length !== 1 || trust.services[0] !== PROVIDER_TRUST_SERVICE) {
      violations.push(`trust policy が ${PROVIDER_TRUST_SERVICE} 以外を信頼している: ${trust.services.join(', ') || '(なし)'}`);
    }
    // Principal だけでなく **Action も**固定する。`sts:AssumeRoleWithWebIdentity` を
    // 許すと OIDC 経由で外部から assume できる形になりうる。
    if (trust.actions.length !== 1 || trust.actions[0] !== PROVIDER_TRUST_ACTION) {
      violations.push(`trust policy の Action が sts:AssumeRole 以外を含む: ${trust.actions.join(', ') || '(なし)'}`);
    }
  }

  const managed = props.ManagedPolicyArns;
  if (managed !== undefined) {
    if (!Array.isArray(managed)) {
      violations.push('ManagedPolicyArns が配列でない');
    } else {
      for (const entry of managed) {
        const literal = managedPolicyArnLiteral(entry);
        if (literal === null || !literal.endsWith(PROVIDER_MANAGED_POLICY_SUFFIX)) {
          violations.push(`想定外の ManagedPolicyArn: ${literal ?? '(リテラルでない)'}`);
        }
      }
    }
  }

  const statements = collectInlineStatements(props.Policies);
  if (statements === null) {
    violations.push('インラインポリシーの Action / Resource を読み取れない');
  } else {
    violations.push(...carveOutStatementViolations(statements).map((v) => `boundary の無いロール: ${v}`));
  }

  return violations;
}

// ---------------------------------------------------------------------------
// テンプレートの組み込み関数を、判定に必要な範囲だけ解決する
// ---------------------------------------------------------------------------

/**
 * 解決できなかった部分を表す印。**ARN のどのフィールドにも現れ得ない文字**を使う
 * （NUL 番兵は ripgrep がファイルを binary と見なすので使わない。`cfn-generated-name.ts`
 * で同じ轍を踏んでいる）。
 */
const UNRESOLVED_MARKER = '<unresolved>';

/** テンプレートで値が決まっている擬似パラメータ。 */
const PSEUDO_PARAMETERS: Readonly<Record<string, string>> = {
  'AWS::Partition': 'aws',
  'AWS::AccountId': CARVE_OUT_ACCOUNT_ID,
  'AWS::URLSuffix': 'amazonaws.com',
};

/**
 * `Fn::Join` / `Fn::Sub` / 擬似パラメータの `Ref` を、判定できる範囲で文字列へ潰す。
 *
 * 実測: CDK は同じ distribution ARN を **2 通り**で書く ——
 * `arn:aws:cloudfront::822063948773:distribution/` + `Ref`（アカウントがリテラル）と、
 * `arn:` + `Ref(AWS::Partition)` + `:cloudfront::` + `Ref(AWS::AccountId)` + …。
 * どちらも通さないと初回デプロイが止まるので、両方を扱う。
 * 解決できない部分は `UNRESOLVED_MARKER` になり、**アカウント一致には決してならない**。
 */
function resolveTemplateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isRecord(v)) {
    const ref = v.Ref;
    if (typeof ref === 'string') return PSEUDO_PARAMETERS[ref] ?? UNRESOLVED_MARKER;
    const join = v['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && typeof join[0] === 'string' && Array.isArray(join[1])) {
      return join[1].map(resolveTemplateString).join(join[0]);
    }
    const sub = v['Fn::Sub'];
    if (typeof sub === 'string') {
      return sub.replace(/\$\{([^}]+)\}/g, (_m, name: string) => PSEUDO_PARAMETERS[name] ?? UNRESOLVED_MARKER);
    }
  }
  return UNRESOLVED_MARKER;
}

/** ARN のアカウント欄（5 番目）がこのアカウントか。 */
function arnNamesThisAccount(arn: string): boolean {
  const fields = arn.split(':');
  return fields.length >= 5 && fields[4] === CARVE_OUT_ACCOUNT_ID;
}

/**
 * `{ 'Fn::GetAtt': [<論理 ID>, <属性>] }` から論理 ID を取り出す。
 * CloudFormation は `"A.Arn"` という短縮形も受け付けるので両方扱う
 * （**同じ意味の別の綴りで検査を迂回させない**）。
 */
function getAttLogicalId(v: unknown, attribute: string): string | null {
  if (!isRecord(v)) return null;
  const g = v['Fn::GetAtt'];
  if (Array.isArray(g) && g.length === 2 && typeof g[0] === 'string' && g[1] === attribute) {
    return g[0];
  }
  if (typeof g === 'string') {
    const dot = g.indexOf('.');
    if (dot > 0 && g.slice(dot + 1) === attribute) return g.slice(0, dot);
  }
  return null;
}

/**
 * `AWS::Lambda::Permission` の `Principal` が、この account 内 / AWS サービスに閉じているか。
 *
 * 🔴 サービスプリンシパルを無条件に通してよいわけではない。`SourceAccount` /
 * `SourceArn` の無い `apigateway.amazonaws.com` 宛の許可は、**別アカウントの API から
 * この Lambda を呼べる**という意味になる。閉じているかは `permissionSourceNamesThisAccount`
 * が別途見る。
 */
function isServicePrincipal(principal: string): boolean {
  return principal.endsWith('.amazonaws.com');
}

function isSameAccountPrincipal(principal: string): boolean {
  if (principal === CARVE_OUT_ACCOUNT_ID) return true;
  return principal.startsWith(`arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:`);
}

/** `SourceAccount` / `SourceArn` が**このアカウント**を名指ししているか。 */
function permissionSourceNamesThisAccount(props: TemplateProperties): boolean {
  if (props.SourceAccount !== undefined) {
    if (resolveTemplateString(props.SourceAccount) === CARVE_OUT_ACCOUNT_ID) return true;
  }
  if (props.SourceArn !== undefined) {
    if (arnNamesThisAccount(resolveTemplateString(props.SourceArn))) return true;
  }
  return false;
}

/**
 * 停止条件は 1 行で移せるようにしておく（spec §6 の注記）。
 * 「IAM Role/Policy の Add・Modify も止める」に変えたい場合はここを触る。
 */
export function evaluateDeployChangeSet(summary: ChangeSetSummary): DeployGateVerdict {
  const blocks: DeployBlock[] = [];
  const flags: DeployFlag[] = [];

  if (!ALLOWED_STACK_PATTERN.test(summary.stackName)) {
    blocks.push({
      reason: 'unexpectedStack',
      evidence: `stack=${summary.stackName} は ${ALLOWED_STACK_PATTERN.source} に一致しません`,
    });
  }

  for (const c of summary.changes) {
    const evidence = describeChange(c);

    if (c.action === 'Remove') {
      blocks.push({ reason: 'resourceRemoval', evidence });
    }
    // Remove 以外で安全でない action（Import, Dynamic, 未知の値）は止める。
    // Add と Modify だけが既知で安全。
    if (!SAFE_ACTIONS.has(c.action) && c.action !== 'Remove') {
      blocks.push({ reason: 'unknownAction', evidence });
    }
    // 'Conditional' は実行時条件で決まる＝安全だと証明できないので止める側に倒す。
    if (c.replacement === 'True' || c.replacement === 'Conditional') {
      blocks.push({ reason: 'resourceReplacement', evidence });
    }
    for (const [prefix, reason] of BLOCKED_TYPE_PREFIXES) {
      if (c.resourceType.startsWith(prefix)) blocks.push({ reason, evidence });
    }
    if (IAM_PRINCIPAL_TYPES.has(c.resourceType)) {
      blocks.push({ reason: 'iamPrincipalChange', evidence });
    }
    if (c.resourceType.startsWith('AWS::IAM::') && !IAM_PRINCIPAL_TYPES.has(c.resourceType)) {
      flags.push({ reason: 'iamPolicyChange', evidence });
    }

    // #680 R10。**Add だけでなく Modify も見る。**
    // ロールの trust policy とインラインポリシーは**物理名を変えずに**書き換えられるので、
    // 「Add のときだけ名前空間を見る」では、既に存在する provider role を後から
    // 外部アカウントへ向け直す変更が素通りする。
    if (c.action === 'Add' || c.action === 'Modify') {
      evaluateSensitiveResource(summary, c, evidence, blocks, flags);
    }
  }

  return { blocked: blocks.length > 0, blocks, flags };
}

/**
 * carve-out されたロール / Function URL / 公開 invoke 権限を、**テンプレートの実体**で判定する。
 * ここだけが「論理 ID ではなく中身」を見ている部分。
 */
function evaluateSensitiveResource(
  summary: ChangeSetSummary,
  c: ChangeSetResourceChange,
  evidence: string,
  blocks: DeployBlock[],
  flags: DeployFlag[],
): void {
  const resource = lookupResource(summary.templateResources, c.logicalResourceId);
  // 🔴 **change set 側の種別だけで watched を決めない。** テンプレート側の `Type` も
  // 見る（両者が食い違ったら止める）。片方の綴りだけを見る検査は、payload を
  // 隣の種別へ移すだけで抜けられる。
  const watched =
    WATCHED_RESOURCE_TYPES.has(c.resourceType) ||
    (resource !== undefined && WATCHED_RESOURCE_TYPES.has(resource.type));
  if (!watched) return;

  if (resource === undefined) {
    // 🔴 「テンプレートに無い＝無害」ではない。読めなかっただけである。
    blocks.push({
      reason: 'opaqueResourceShape',
      evidence: `${evidence} — synth テンプレートに該当する論理 ID がなく、中身を検査できません`,
    });
    return;
  }
  if (resource.type !== c.resourceType) {
    blocks.push({
      reason: 'opaqueResourceShape',
      evidence: `${evidence} — change set と synth テンプレートで種別が食い違います（テンプレート側は ${resource.type}）`,
    });
    return;
  }
  const props = resource.properties;

  if (c.resourceType === 'AWS::IAM::Role') {
    evaluateRole(summary.stackName, c, props, evidence, blocks, flags);
    return;
  }

  if (POLICY_ATTACHMENT_TYPES.has(c.resourceType)) {
    evaluatePolicyAttachment(summary, c, props, evidence, blocks);
    return;
  }

  if (c.resourceType === 'AWS::Lambda::Url') {
    evaluateFunctionUrl(c, props, evidence, blocks);
    return;
  }

  if (c.resourceType === 'AWS::Lambda::Permission') {
    evaluatePermission(c, props, evidence, blocks);
    return;
  }

  // 🔴 **fall-through で最後の検査へ流さない。** `WATCHED_RESOURCE_TYPES` に
  // 種別を足して dispatch を足し忘れたときに、無関係な検査が偶然通す／偶然止める
  // （＝理由の違う緑・赤）ことを防ぐ。
  blocks.push({
    reason: 'opaqueResourceShape',
    evidence: `${evidence} — 検査対象の種別ですが、対応する検査が実装されていません`,
  });
}

/**
 * 🔴 **権限は「ロールの Properties」以外からも carve-out のロールへ届く
 * （レビュー Blocking 1）。**
 *
 * `AWS::IAM::Policy` / `AWS::IAM::ManagedPolicy` / `AWS::IAM::RolePolicy` は
 * **別リソース**でありながら `Roles` / `RoleName` で既存ロールへ権限を足す。
 * IAM 側の `AllowCdkProviderRoleMutationWithoutBoundary` は carve-out ARN に対する
 * `iam:PutRolePolicy` / `iam:AttachRolePolicy` を**無条件で**許しているので、
 * ここを見ないと `carveOutRoleShape` は「インラインを 1 つ左のリソースへ移す」だけで
 * 迂回できる。change set にロールが 1 件も現れない Modify でも同じことが起きる。
 */
function evaluatePolicyAttachment(
  summary: ChangeSetSummary,
  c: ChangeSetResourceChange,
  props: TemplateProperties,
  evidence: string,
  blocks: DeployBlock[],
): void {
  if (props.Users !== undefined || props.Groups !== undefined) {
    blocks.push({
      reason: 'iamPrincipalChange',
      evidence: `${evidence} — IAM ユーザー / グループへポリシーを付けています。dev スタックにその理由はありません`,
    });
    return;
  }

  const rawTargets =
    c.resourceType === 'AWS::IAM::RolePolicy'
      ? props.RoleName === undefined
        ? []
        : [props.RoleName]
      : props.Roles === undefined
        ? []
        : props.Roles;
  if (!Array.isArray(rawTargets)) {
    blocks.push({
      reason: 'opaqueResourceShape',
      evidence: `${evidence} — 付与先ロールの指定が配列でなく、carve-out に入らないと証明できません`,
    });
    return;
  }

  const carveOutTargets: string[] = [];
  for (const target of rawTargets) {
    const resolved = resolvePolicyRoleTarget(summary, target);
    if (resolved.kind === 'opaque') {
      blocks.push({
        reason: 'opaqueResourceShape',
        evidence: `${evidence} — 付与先ロールを静的に決定できません: ${resolved.detail}`,
      });
      return;
    }
    if (resolved.kind === 'carveOut') carveOutTargets.push(resolved.detail);
  }
  if (carveOutTargets.length === 0) return;

  // 🔴 ロール本体の `Policies` と**同じ**検査を掛ける（action の許可リストだけでなく
  // `Resource` の閉じ込めも）。片方だけに掛けると、payload を隣のリソースへ移すだけで
  // 広い `Resource` が通ってしまう ―― Blocking 1 とまったく同じ形の穴になる。
  const statements = collectPolicyDocumentStatements(props.PolicyDocument);
  if (statements === null) {
    blocks.push({
      reason: 'carveOutRoleShape',
      evidence: `${evidence} — carve-out のロール（${carveOutTargets.join(' / ')}）へ付ける PolicyDocument の Action / Resource を読み取れません`,
    });
    return;
  }
  const violations = carveOutStatementViolations(statements);
  if (violations.length > 0) {
    blocks.push({
      reason: 'carveOutRoleShape',
      evidence:
        `${evidence} — carve-out のロール（${carveOutTargets.join(' / ')}）に Permissions Boundary は` +
        `掛かりません。${violations.join(' / ')}`,
    });
  }
}

type PolicyRoleTarget =
  | { readonly kind: 'carveOut'; readonly detail: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'opaque'; readonly detail: string };

/**
 * `Roles: [...]` / `RoleName` の 1 要素が、carve-out のロールを指すかを解決する。
 *
 * - `Ref` / `Fn::GetAtt` … テンプレート内の**論理 ID**を引き、`Type` が
 *   `AWS::IAM::Role` であることまで確かめる。ここで `Type` を見ないと、
 *   `Ref` が返す文字列が role 名になる**別種別**（`AWS::SSM::Parameter` の `Name` 等）へ
 *   carve-out の実在ロール名を書くだけで抜けられる
 * - リテラルの role 名 … ARN の `Path` が分からない以上「carve-out の**外**である」と
 *   証明できない（グロブの `*` は `/` を跨ぐ）。**通さず、carve-out 扱いで検査する**
 * - それ以外（`Fn::Join` など） … 判定不能として止める
 */
function resolvePolicyRoleTarget(summary: ChangeSetSummary, target: unknown): PolicyRoleTarget {
  const referenced =
    isRecord(target) && typeof target.Ref === 'string'
      ? target.Ref
      : (getAttLogicalId(target, 'Arn') ?? getAttLogicalId(target, 'RoleName'));

  if (referenced !== null && referenced !== undefined) {
    const resource = lookupResource(summary.templateResources, referenced);
    if (resource === undefined) {
      return { kind: 'opaque', detail: `参照先 ${referenced} が synth テンプレートにありません` };
    }
    if (resource.type !== 'AWS::IAM::Role') {
      return {
        kind: 'opaque',
        detail: `参照先 ${referenced} は AWS::IAM::Role ではなく ${resource.type} です`,
      };
    }
    const resolved = resolveRoleArn(summary.stackName, referenced, resource.properties);
    if (resolved.kind === 'opaque') return { kind: 'opaque', detail: resolved.detail };
    const inCarveOut =
      resolved.kind === 'exact'
        ? iamArnGlobMatches(CARVE_OUT_ROLE_ARN_PATTERN, resolved.arn)
        : iamArnGlobMatchesGeneratedName(CARVE_OUT_ROLE_ARN_PATTERN, resolved.arnPrefix);
    return inCarveOut ? { kind: 'carveOut', detail: referenced } : { kind: 'outside' };
  }

  if (typeof target === 'string') {
    return {
      kind: 'carveOut',
      detail: `${target}（リテラル名。Path が不明なので carve-out の外だと証明できません）`,
    };
  }

  return { kind: 'opaque', detail: '付与先が Ref / Fn::GetAtt / リテラル名のいずれでもありません' };
}

function evaluateFunctionUrl(
  c: ChangeSetResourceChange,
  props: TemplateProperties,
  evidence: string,
  blocks: DeployBlock[],
): void {
  const expectedFunction = expectedTargetFunction(
    REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls,
    c.logicalResourceId,
  );
  if (expectedFunction === undefined) {
    blocks.push({
      reason: 'functionUrlExposure',
      evidence:
        `${evidence} — WebStack が作る Function URL は 2 本` +
        `（${Object.keys(REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls).join(' / ')}）だけです。` +
        '未知の Function URL は、資格情報が切れたあとも残る公開 HTTPS 入口になります',
    });
    return;
  }

  // 🔴 論理 ID が allowlist にあることは「その URL が本物の関数に付いている」ことを
  // 意味しない。**初回デプロイでは全リソースが Add** なので、この論理 ID を
  // ServerFn / ImageFn へ結び付けているものは他に何も無い。向き先を固定する。
  const target = getAttLogicalId(props.TargetFunctionArn, 'Arn');
  if (target !== expectedFunction) {
    blocks.push({
      reason: 'functionUrlExposure',
      evidence:
        `${evidence} — ${c.logicalResourceId} は ${expectedFunction} の Function URL のはずですが、` +
        `TargetFunctionArn が ${target ?? '静的に読めない値'} を指しています`,
    });
    return;
  }

  const authType = props.AuthType;
  if (typeof authType !== 'string') {
    blocks.push({ reason: 'opaqueResourceShape', evidence: `${evidence} — AuthType がリテラルでない` });
    return;
  }
  if (c.logicalResourceId === AWS_IAM_ONLY_FUNCTION_URL && authType !== 'AWS_IAM') {
    blocks.push({
      reason: 'functionUrlExposure',
      evidence:
        `${evidence} — image の Function URL は常に AWS_IAM です (#631)。AuthType=${authType} は` +
        '無認証・無検証の公開エンドポイントになります',
    });
  }
}

function evaluatePermission(
  c: ChangeSetResourceChange,
  props: TemplateProperties,
  evidence: string,
  blocks: DeployBlock[],
): void {
  const principal = props.Principal;
  if (typeof principal !== 'string') {
    blocks.push({ reason: 'opaqueResourceShape', evidence: `${evidence} — Principal がリテラルでない` });
    return;
  }

  if (principal === '*') {
    const expectedFunction = expectedTargetFunction(
      REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions,
      c.logicalResourceId,
    );
    if (expectedFunction === undefined) {
      blocks.push({
        reason: 'publicInvokePermission',
        evidence:
          `${evidence} — Principal:"*" の invoke 許可はリソースポリシーとして残り、` +
          'デプロイ窓が閉じても消えません',
      });
      return;
    }
    // URL と同じ理由で**向き先**まで固定する（論理 ID は攻撃者が選べる）。
    const target = getAttLogicalId(props.FunctionName, 'Arn');
    if (target !== expectedFunction) {
      blocks.push({
        reason: 'publicInvokePermission',
        evidence:
          `${evidence} — CDK が足す Principal:"*" の許可は ${expectedFunction} 宛のはずですが、` +
          `FunctionName が ${target ?? '静的に読めない値'} を指しています`,
      });
    }
    return;
  }

  if (isServicePrincipal(principal)) {
    // 🔴 `*.amazonaws.com` を無条件に通すと、`apigateway.amazonaws.com` へ
    // source 条件無しで許可する形が通ってしまう ―― **別アカウント**の API から
    // この Lambda を呼べる、実在する越境経路である。
    if (!permissionSourceNamesThisAccount(props)) {
      blocks.push({
        reason: 'publicInvokePermission',
        evidence:
          `${evidence} — サービスプリンシパル ${principal} への invoke 許可に、このアカウントを` +
          '名指しする SourceAccount / SourceArn がありません（別アカウント経由で呼べます）',
      });
    }
    return;
  }

  if (!isSameAccountPrincipal(principal)) {
    blocks.push({
      reason: 'publicInvokePermission',
      evidence: `${evidence} — Principal=${principal} はこのアカウント外です（永続する外部からの invoke 経路）`,
    });
  }
}

function evaluateRole(
  stackName: string,
  c: ChangeSetResourceChange,
  props: TemplateProperties,
  evidence: string,
  blocks: DeployBlock[],
  flags: DeployFlag[],
): void {
  const resolved = resolveRoleArn(stackName, c.logicalResourceId, props);
  if (resolved.kind === 'opaque') {
    blocks.push({
      reason: 'opaqueResourceShape',
      evidence: `${evidence} — 物理名を決定できないので carve-out に入らないと証明できません: ${resolved.detail}`,
    });
    return;
  }

  const inCarveOut =
    resolved.kind === 'exact'
      ? iamArnGlobMatches(CARVE_OUT_ROLE_ARN_PATTERN, resolved.arn)
      : iamArnGlobMatchesGeneratedName(CARVE_OUT_ROLE_ARN_PATTERN, resolved.arnPrefix);

  if (!inCarveOut) {
    // carve-out の外は Permissions Boundary が強制される（IAM 側の Deny）。
    // それでも trust policy だけは boundary の管轄外なので、外向きの信頼は止める。
    const trust = classifyTrustPolicy(props.AssumeRolePolicyDocument);
    if (trust.kind === 'external') {
      blocks.push({
        reason: 'roleTrustPolicyEscape',
        evidence: `${evidence} — ${trust.detail}。boundary はロールの信頼先を縛れません`,
      });
    } else if (trust.kind === 'opaque') {
      // 止めない。CDK は自アカウントの ARN を Fn::Join で組むので、ここを止めると
      // 正当な初回デプロイが通らなくなる。**代わりに 4d の人間へ必ず見せる。**
      flags.push({
        reason: 'opaqueRoleTrustPolicy',
        evidence: `${evidence} — trust policy を静的に読み切れません: ${trust.detail}`,
      });
    }
    return;
  }

  const known = (
    REVIEWED_CDK_GENERATED_LOGICAL_IDS.carveOutProviderRoles as ReadonlyArray<string>
  ).includes(c.logicalResourceId);
  const where =
    resolved.kind === 'exact' ? `RoleName/Path 指定 (${resolved.arn})` : `生成名 (${resolved.arnPrefix}…)`;

  if (!known) {
    blocks.push({
      reason: 'carveOutRoleNamespace',
      evidence:
        `${evidence} — ${where} が carve-out ${CARVE_OUT_ROLE_ARN_PATTERN} に入ります。` +
        'この名前空間のロールには Permissions Boundary が掛かりません',
    });
    return;
  }

  const violations = carveOutShapeViolations(props);
  if (violations.length > 0) {
    blocks.push({
      reason: 'carveOutRoleShape',
      evidence:
        `${evidence} — 既知の provider role の論理 ID ですが、実体が CDK の生成する形と違います: ` +
        violations.join(' / '),
    });
  }
}
