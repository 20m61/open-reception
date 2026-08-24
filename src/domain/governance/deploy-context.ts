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
 *
 * ## `providerSecretBackend` を後から足した理由（2026-08-24）
 *
 * #768 でテナントプロバイダ**設定**を永続化した結果、**設定と secret の永続性が非対称に**
 * なった。`providerSecretBackend` を渡さないと secret ストアは in-memory のままで
 * （`bin/open-reception.ts`「未指定なら in-memory mock のまま」／
 * `tenant-secret-store.ts` の `?? 'memory'`／`web-stack.ts` は `=== 'secrets-manager'` の
 * ときだけ env を注入する）、実 Vonage 資格情報を入れても **Lambda インスタンスをまたぐと消える**。
 *
 * 🔴 **この非対称は来訪者に見える。** 設定は残るので `intendsRealDialing` は true を返し、
 * secret は消えるので `buildVoiceCredentials` は null を返す ―― #765 のガードが発火して
 * **受付が `unrouted`（503）になる**。しかもどのインスタンスが処理したかで結果が変わるので、
 * 「たまに取り次げない」という最も切り分けにくい形で出る。
 *
 * 扱いは `DATA_BACKEND`（`src/lib/data/index.ts`）に揃える ――
 * **明示を要求し、明示的な `memory` は「意図的に揮発でよい」宣言として許容する**。
 * mock だけで動かす dev デプロイを禁じないため、値の選択自体は運用者に委ねる。
 */

/** 未指定なら deploy を止める環境変数と、対応する CDK context キー。 */
const REQUIRED: ReadonlyArray<readonly [envVar: string, contextKey: string, why: string]> = [
  ['OR_APP_SECRETS_NAME', 'appSecretsName', '省くと Secrets Manager 連携が落ちて起動が 500 になる'],
  ['OR_ORIGIN_VERIFY_SECRET', 'originVerifySecret', '省くと CloudFront 経由の POST が全滅する（403）'],
  ['OR_PUBLIC_ORIGIN_OVERRIDE', 'publicOriginOverride', '省くと発行される QR が誰にも使えない'],
  [
    'OR_PROVIDER_SECRET_BACKEND',
    'providerSecretBackend',
    "省くとテナント provider secret が in-memory のままになり、実資格情報を入れても Lambda をまたぐと消える（受付が断続的に 503）。mock だけで動かすなら 'memory' と明示する",
  ],
];

/**
 * `providerSecretBackend` に許す値。
 *
 * 🔴 **未知の値を黙って通さない。** `bin/open-reception.ts` は
 * `'memory' | 'secrets-manager' | undefined` へ**キャストするだけで検証していない**ので、
 * 綴り違い（`secretsmanager` 等）は web-stack の `=== 'secrets-manager'` に一致せず
 * **静かに memory へ倒れる**。設定したつもりで揮発する、いちばん気づけない失敗になる。
 */
const PROVIDER_SECRET_BACKENDS: ReadonlyArray<string> = ['memory', 'secrets-manager'];

export const REQUIRED_DEPLOY_CONTEXT_VARS: ReadonlyArray<string> = REQUIRED.map(([envVar]) => envVar);

export type DeployContextResult =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly missing: ReadonlyArray<string>;
      /** 値が語彙の外だった変数。未指定（`missing`）とは別に数える。 */
      readonly invalid: ReadonlyArray<string>;
      readonly message: string;
    };

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
  const invalid: string[] = [];
  const args: string[] = [];

  for (const [envVar, contextKey] of REQUIRED) {
    const raw = env[envVar];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      missing.push(envVar);
      continue;
    }
    if (contextKey === 'providerSecretBackend' && !PROVIDER_SECRET_BACKENDS.includes(value)) {
      invalid.push(envVar);
      continue;
    }
    args.push('-c', `${contextKey}=${value}`);
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      missing,
      invalid,
      message: [
        'デプロイ context の値が不正です:',
        // 🔴 値そのものは載せない（他の必須変数は秘密を運ぶ。ここだけ例外にすると型が崩れる）。
        ...invalid.map(
          (envVar) => `  ${envVar}  →  ${PROVIDER_SECRET_BACKENDS.join(' | ')} のいずれか`,
        ),
        '',
        '綴り違いは web-stack の判定に一致せず、静かに in-memory へ倒れます。',
        '設定したつもりで揮発するので、ここで止めます。',
      ].join('\n'),
    };
  }

  if (missing.length > 0) {
    const lines = REQUIRED.filter(([envVar]) => missing.includes(envVar)).map(
      ([envVar, contextKey, why]) => `  ${envVar}  →  -c ${contextKey}=...   （${why}）`,
    );
    return {
      ok: false,
      missing,
      invalid,
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
