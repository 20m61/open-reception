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
 */
export const REVIEWED_CDK_GENERATED_LOGICAL_IDS = {
  carveOutProviderRoles: [
    'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
    'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
    'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
  ],
  functionUrls: ['ServerFnFunctionUrlFFF9E3E1', 'ImageFnFunctionUrlBBD47D3E'],
  publicInvokePermissions: ['ServerFninvokefunctionurl715820CF', 'ServerFninvokefunctionA3A7399A'],
} as const;

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

/**
 * carve-out されたロールのインラインポリシーに現れてはいけない action。
 *
 * 実測した provider role のインラインは `ssm:` の 3〜4 アクションだけである。
 * ここで挙げるのは**境界そのものが守っている領域**（IAM の書き換え・別 principal への
 * 成り代わり・鍵・secret）で、boundary の掛からないロールにこれらが載ると
 * 「boundary を外した」ではなく「boundary を無意味にした」になる。
 */
const CARVE_OUT_FORBIDDEN_ACTION_PREFIXES = ['iam:', 'sts:', 'kms:', 'secretsmanager:', 'organizations:'];

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

/** 論理 ID → `Properties`。`cdk.out/<stack>.template.json` の `Resources` から作る。 */
export type StackTemplateResources = Readonly<Record<string, TemplateProperties>>;

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
  | { readonly kind: 'serviceOnly'; readonly services: ReadonlyArray<string> }
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
  let opaque: string | null = null;

  for (const raw of statements) {
    if (!isRecord(raw)) return { kind: 'opaque', detail: 'Statement の要素がオブジェクトでない' };
    // Deny は権限を与えないので、信頼先の判定には効かない。
    if (raw.Effect === 'Deny') continue;

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
  return { kind: 'serviceOnly', services };
}

/** managed policy ARN のリテラル表現を取り出す（`Fn::Sub` の文字列形も許す）。 */
function managedPolicyArnLiteral(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (isRecord(v) && typeof v['Fn::Sub'] === 'string') return v['Fn::Sub'];
  return null;
}

/** インラインポリシーに現れる action を集める。読めないものがあれば `null`。 */
function collectInlineActions(policies: unknown): ReadonlyArray<string> | null {
  if (policies === undefined) return [];
  if (!Array.isArray(policies)) return null;
  const actions: string[] = [];
  for (const policy of policies) {
    if (!isRecord(policy)) return null;
    const doc = policy.PolicyDocument;
    if (!isRecord(doc) || !Array.isArray(doc.Statement)) return null;
    for (const stmt of doc.Statement) {
      if (!isRecord(stmt)) return null;
      if (stmt.Effect === 'Deny') continue;
      const list = asStringList(stmt.Action);
      if (list === null) return null;
      actions.push(...list);
    }
  }
  return actions;
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
  } else if (trust.services.length !== 1 || trust.services[0] !== PROVIDER_TRUST_SERVICE) {
    violations.push(`trust policy が ${PROVIDER_TRUST_SERVICE} 以外を信頼している: ${trust.services.join(', ') || '(なし)'}`);
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

  const actions = collectInlineActions(props.Policies);
  if (actions === null) {
    violations.push('インラインポリシーの Action を読み取れない');
  } else {
    for (const action of actions) {
      const lower = action.toLowerCase();
      if (action === '*' || CARVE_OUT_FORBIDDEN_ACTION_PREFIXES.some((p) => lower.startsWith(p))) {
        violations.push(`boundary の無いロールに載せてはいけない action: ${action}`);
      }
    }
  }

  return violations;
}

/** `AWS::Lambda::Permission` の `Principal` が、この account 内 / AWS サービスに閉じているか。 */
function isContainedPermissionPrincipal(principal: string): boolean {
  if (principal.endsWith('.amazonaws.com')) return true;
  if (principal === CARVE_OUT_ACCOUNT_ID) return true;
  return principal.startsWith(`arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:`);
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
  const watched =
    c.resourceType === 'AWS::IAM::Role' ||
    c.resourceType === 'AWS::Lambda::Url' ||
    c.resourceType === 'AWS::Lambda::Permission';
  if (!watched) return;

  const props = summary.templateResources[c.logicalResourceId];
  if (props === undefined) {
    // 🔴 「テンプレートに無い＝無害」ではない。読めなかっただけである。
    blocks.push({
      reason: 'opaqueResourceShape',
      evidence: `${evidence} — synth テンプレートに該当する論理 ID がなく、中身を検査できません`,
    });
    return;
  }

  if (c.resourceType === 'AWS::IAM::Role') {
    evaluateRole(summary.stackName, c, props, evidence, blocks, flags);
    return;
  }

  if (c.resourceType === 'AWS::Lambda::Url') {
    const known = (REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls as ReadonlyArray<string>).includes(
      c.logicalResourceId,
    );
    if (!known) {
      blocks.push({
        reason: 'functionUrlExposure',
        evidence:
          `${evidence} — WebStack が作る Function URL は 2 本` +
          `（${REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls.join(' / ')}）だけです。` +
          '未知の Function URL は、資格情報が切れたあとも残る公開 HTTPS 入口になります',
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
    return;
  }

  // AWS::Lambda::Permission
  const principal = props.Principal;
  if (typeof principal !== 'string') {
    blocks.push({ reason: 'opaqueResourceShape', evidence: `${evidence} — Principal がリテラルでない` });
    return;
  }
  if (principal === '*') {
    const known = (
      REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions as ReadonlyArray<string>
    ).includes(c.logicalResourceId);
    if (!known) {
      blocks.push({
        reason: 'publicInvokePermission',
        evidence:
          `${evidence} — Principal:"*" の invoke 許可はリソースポリシーとして残り、` +
          'デプロイ窓が閉じても消えません',
      });
    }
    return;
  }
  if (!isContainedPermissionPrincipal(principal)) {
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
