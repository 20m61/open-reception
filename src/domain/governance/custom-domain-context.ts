/**
 * `OR_CUSTOM_DOMAIN` を CDK の `-c customDomain=<json>` へ変換する述語（#189 の配線）。
 *
 * ## なぜ要るか
 *
 * 独自ドメインの仕組み（`infra/lib/stacks/web-stack.ts` の `CustomDomainConfig`）は #189 で
 * 実装済みだが、**クラウドのデプロイ経路に配線されていなかった**。`aws-cloud-deploy.sh` が
 * `cdk` へ渡すのは `env` / `bootstrapQualifier` / `claudeBoundary` ＋
 * `resolveDeployContext` の必須 4 変数だけで、`customDomain` を渡す口が無い。
 *
 * ## 何を落とすか（どれも「窓を消費してから気づく」型）
 *
 * 🔴 **`createDnsRecord: true`。** このデプロイ経路は `route53:*` が**明示 Deny**
 * （`scripts/aws-policies/claude-boundary.json` の `DenySharedDnsAndCertificates`、
 * `claude-cfn-exec.json` の `DenyDnsAndPrincipals`）。Deny は「**共有**の DNS と証明書を
 * 触らせない」という意図で、同一アカウントには他プロジェクトが同居している。通すと
 * synth の `HostedZone.fromLookup` か deploy 途中で AccessDenied になり、**原因が DNS 権限
 * だと読めないまま窓を食う**。alias レコードはゾーン管理者が別途作る前提なので、
 * ここで理由ごと落とす。
 *
 * 🔴 **us-east-1 以外の証明書。** CloudFront は us-east-1 の ACM しか受け付けない。
 * ap-northeast-1 の ARN は **synth を通ってデプロイで落ちる**。
 *
 * 🔴 **プレースホルダ。** `docs/deploy-aws.md` の例は
 * `arn:aws:acm:us-east-1:<acct>:certificate/<id>` という**そのまま貼れる形**をしている。
 * 2026-09-06 の 4 回目のデプロイは、runbook の散文を貼った値で deploy 直前まで進んだ
 * （#995）。同じ穴を開けたままにしない。
 *
 * 判定はここ（純関数）に置き、bash は観測を渡すだけにする。
 */

/** CDK context のキー。`infra/bin/open-reception.ts` が `tryGetContext` で読む名前。 */
const CONTEXT_KEY = 'customDomain';

/** 山括弧（ASCII / 全角）。正当な ARN・FQDN に山括弧は現れない。 */
const PLACEHOLDER_BRACKETS = /[<>＜＞]/u;

/**
 * us-east-1 の ACM 証明書 ARN。
 *
 * 🔴 **リージョンを ARN の一部として縛る。** 「ACM の ARN であること」だけを見ると、
 * ap-northeast-1 の証明書が通ってしまい、CloudFront が受け付けない構成が synth を通る。
 */
const US_EAST_1_ACM_CERT_ARN =
  /^arn:aws[a-z-]*:acm:us-east-1:\d{12}:certificate\/[0-9a-fA-F-]+$/u;

/** ACM 証明書 ARN（リージョン不問）。リージョン違いを「ARN ですらない」と混同しないため。 */
const ANY_ACM_CERT_ARN = /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-fA-F-]+$/u;

/**
 * FQDN。ラベルは英数字とハイフン、先頭・末尾はハイフン不可、ドット区切りが 2 つ以上。
 * スキーム付き（`https://…`）や空白混じりを弾くのが目的で、DNS の完全な文法ではない。
 */
const FQDN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/iu;

export type CustomDomainContextResult =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function fail(...lines: ReadonlyArray<string>): CustomDomainContextResult {
  return { ok: false, message: lines.join('\n') };
}

/**
 * `OR_CUSTOM_DOMAIN` を解決する。
 *
 * **未指定は正常**（CDK 生成ドメインのみ）。必須 4 変数と違い、ここを必須にすると
 * 独自ドメインを使わない環境の deploy を全部止めてしまう。
 */
export function resolveCustomDomainContext(raw: string | undefined): CustomDomainContextResult {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { ok: true, args: [] };

  if (PLACEHOLDER_BRACKETS.test(value)) {
    return fail(
      'OR_CUSTOM_DOMAIN が山括弧つきのプレースホルダのままです。',
      'docs/deploy-aws.md の例は <acct> / <id> を含む「貼れる形」をしているので、',
      '実際の値へ置き換えてください（2026-09-06 に同じ型で deploy 直前まで進みました）。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return fail(
      `OR_CUSTOM_DOMAIN を JSON として読めません: ${(e as Error).message}`,
      '例: {"domainName":"open-reception.example.com","certificateArn":"arn:aws:acm:us-east-1:…"}',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('OR_CUSTOM_DOMAIN は JSON オブジェクトである必要があります。');
  }
  const config = parsed as Record<string, unknown>;

  // `bin/open-reception.ts` と同じ意味にする（enabled:false は「使わない」）。
  if (config.enabled === false) return { ok: true, args: [] };

  const domainName = config.domainName;
  if (typeof domainName !== 'string' || !FQDN.test(domainName)) {
    return fail(
      'OR_CUSTOM_DOMAIN の domainName が FQDN の形をしていません。',
      'スキーム（https://）やパスを含めず、ホスト名だけを書いてください。',
    );
  }

  const certificateArn = config.certificateArn;
  if (typeof certificateArn !== 'string' || certificateArn === '') {
    return fail(
      'OR_CUSTOM_DOMAIN に certificateArn がありません。',
      'このスタックは証明書を発行しません（既存の us-east-1 ACM 証明書の ARN を渡す）。',
    );
  }
  if (!US_EAST_1_ACM_CERT_ARN.test(certificateArn)) {
    return fail(
      ANY_ACM_CERT_ARN.test(certificateArn)
        ? 'certificateArn が us-east-1 の証明書ではありません。'
        : 'certificateArn が ACM の証明書 ARN の形をしていません。',
      'CloudFront は us-east-1 の ACM 証明書しか受け付けません。',
      'ap-northeast-1 の証明書は synth を通り、デプロイの途中で落ちます。',
    );
  }

  // 🔴 route53:* はこの経路で明示 Deny。通すと窓を消費してから AccessDenied になる。
  if (config.createDnsRecord === true) {
    return fail(
      'createDnsRecord:true は、このデプロイ経路では使えません。',
      'route53:* が明示 Deny です（claude-boundary.json の DenySharedDnsAndCertificates /',
      'claude-cfn-exec.json の DenyDnsAndPrincipals）。共有ゾーンを触らせないための意図的な Deny で、',
      'そのまま進めると synth の HostedZone.fromLookup か deploy 途中で AccessDenied になります。',
      '',
      'createDnsRecord を外す（既定 false）か false にして、CloudFront への紐付けだけ行ってください。',
      'alias / CNAME レコードは、ゾーンを管理している人が別途作ります。',
    );
  }

  // 🔴 入力をそのまま横流ししない。検証済みのフィールドだけを組み直して渡す。
  //    未知のキーをそのまま通すと、綴り違い（createDNSRecord 等）が検査を素通りして
  //    CDK 側へ届き、「指定したつもりで効かない」という最も気づけない形になる。
  const normalized: Record<string, unknown> = { domainName, certificateArn };
  if (Array.isArray(config.additionalDomainNames)) {
    normalized.additionalDomainNames = config.additionalDomainNames;
  }
  if (typeof config.hostedZoneDomainName === 'string') {
    normalized.hostedZoneDomainName = config.hostedZoneDomainName;
  }
  normalized.createDnsRecord = false;

  return { ok: true, args: ['-c', `${CONTEXT_KEY}=${JSON.stringify(normalized)}`] };
}
