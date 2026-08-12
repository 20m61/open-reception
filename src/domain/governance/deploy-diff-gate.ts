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
 * IAM Role / Policy の Add・Modify を止めないのは、exec role が作る Role に
 * Permissions Boundary が強制されるため（spec §4.2 層 4）。**差分レビューより強い保証**。
 */

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
] as const;
export type DeployBlockReason = (typeof DEPLOY_BLOCK_REASONS)[number];

/** 止めないが記録する理由。 */
export const DEPLOY_FLAG_REASONS = ['iamPolicyChange'] as const;
export type DeployFlagReason = (typeof DEPLOY_FLAG_REASONS)[number];

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

export type ChangeSetSummary = {
  readonly stackName: string;
  readonly changes: ReadonlyArray<ChangeSetResourceChange>;
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
  }

  return { blocked: blocks.length > 0, blocks, flags };
}
