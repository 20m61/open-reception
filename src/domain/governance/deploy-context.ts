/**
 * デプロイに必須の CDK context を fail-closed で解決する（#680 / 2026-08-15 のインシデント）。
 *
 * `infra/bin/open-reception.ts` の `appSecretsName` / `originVerifySecret` /
 * `publicOriginOverride` は **未指定でも synth が通る**。通るが、出来上がるのは別構成の
 * スタックで、Secrets Manager 連携も QR の基底オリジンも落ちる。
 *
 * 2026-08-15 に `scripts/aws-cloud-deploy.sh` がこれらを渡していなかったため、dev の
 * ServerFn から `secretsmanager:GetSecretValue` の付与が消え、起動時に secret を読めず
 * fail-closed で中断して **dev が 500** になった。diff gate も止められなかった ――
 * `describe-change-set` は「どの property が変わったか」の名前しか返さず、
 * **消えた IAM 文や環境変数を値として見せない**ため、差分は「26 件の変更」にしか見えない。
 *
 * したがって防波堤はここに置く。**未指定なら deploy を始めさせない。**
 */

/** 未指定なら deploy を止める環境変数と、対応する CDK context キー。 */
const REQUIRED: ReadonlyArray<readonly [envVar: string, contextKey: string, why: string]> = [
  ['OR_APP_SECRETS_NAME', 'appSecretsName', '省くと Secrets Manager 連携が落ちて起動が 500 になる'],
  ['OR_ORIGIN_VERIFY_SECRET', 'originVerifySecret', '省くと CloudFront 経由の POST が全滅する（403）'],
  ['OR_PUBLIC_ORIGIN_OVERRIDE', 'publicOriginOverride', '省くと発行される QR が誰にも使えない'],
];

export const REQUIRED_DEPLOY_CONTEXT_VARS: ReadonlyArray<string> = REQUIRED.map(([envVar]) => envVar);

export type DeployContextResult =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly missing: ReadonlyArray<string>; readonly message: string };

/**
 * 環境変数から `cdk` へ渡す `-c key=value` の並びを組み立てる。
 *
 * 🔴 **空文字は「未指定」として扱う。** `OR_APP_SECRETS_NAME=$UNSET_VAR` のような
 * コピペ事故が空文字を作り、それを「設定された」と読むと、まさに今回の事故が再発する
 * （`lesson-empty-string-means-unknown`）。
 *
 * 🔴 **診断に値を載せない。** `originVerifySecret` は秘密そのもの。変数名だけを出す。
 */
export function resolveDeployContext(
  env: Readonly<Record<string, string | undefined>>,
): DeployContextResult {
  const missing: string[] = [];
  const args: string[] = [];

  for (const [envVar, contextKey] of REQUIRED) {
    const raw = env[envVar];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      missing.push(envVar);
      continue;
    }
    args.push('-c', `${contextKey}=${value}`);
  }

  if (missing.length > 0) {
    const lines = REQUIRED.filter(([envVar]) => missing.includes(envVar)).map(
      ([envVar, contextKey, why]) => `  ${envVar}  →  -c ${contextKey}=...   （${why}）`,
    );
    return {
      ok: false,
      missing,
      message: [
        'デプロイに必須の context が設定されていません:',
        ...lines,
        '',
        'これらは未指定でも synth が通り、別構成のスタックが出来上がります。',
        '2026-08-15 に実際に dev を 500 にしたので、ここで止めます。',
        '値は docs/runbook-cloud-aws-deploy.md を参照してください（リポジトリには置きません）。',
      ].join('\n'),
    };
  }

  return { ok: true, args };
}
