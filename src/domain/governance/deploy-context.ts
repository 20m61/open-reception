/**
 * デプロイに必須の CDK context を fail-closed で解決する（#680 / 2026-08-15 のインシデント）。
 *
 * `infra/bin/open-reception.ts` の `appSecretsName` / `originVerifySecretName` /
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

import { resolveCustomDomainContext } from './custom-domain-context';

/** 未指定なら deploy を止める環境変数と、対応する CDK context キー。 */
const REQUIRED: ReadonlyArray<readonly [envVar: string, contextKey: string, why: string]> = [
  [
    'OR_APP_SECRETS_NAME',
    'appSecretsName',
    '省くとアプリ機密の runtime 読込と origin-verify の動的参照が両方落ちる',
  ],
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

/**
 * 必須 context に生 secret は含めない（#1148）。
 *
 * `OR_APP_SECRETS_NAME` は Secrets Manager の**名前**であり、同じ secret の
 * `ORIGIN_VERIFY_SECRET` キーを CloudFormation dynamic reference で読む。
 * したがって dev の synth / diff / broker validation に secret 値を渡す必要はない。
 *
 * 値の見た目の検査は「説明文や全角を設定値として貼った」事故を fail-closed にするため
 * 引き続き行う。ただし secret 強度の検査はここでは行わない（値そのものを読まないため）。
 */
type InvalidReason = 'vocabulary' | 'placeholder' | 'non-ascii';

/** 山括弧（ASCII / 全角）。必須 context の正当な値に山括弧は現れない。 */
const PLACEHOLDER_BRACKETS = /[<>＜＞]/u;

/**
 * 印字可能 ASCII 以外（空白・制御文字・全角を含む）。
 *
 * Secrets Manager 名・URL・語彙のいずれにも、この運用では非 ASCII を使わない。
 * 非 ASCII が入った場合は「説明文を貼った」事故として止める。
 */
const NON_PRINTABLE_ASCII = /[^\x21-\x7e]/u;

const REASON_HINT: Readonly<Record<InvalidReason, string>> = {
  vocabulary: `${PROVIDER_SECRET_BACKENDS.join(' | ')} のいずれか`,
  placeholder: '山括弧つきのプレースホルダのままです（runbook の記法をそのまま貼っていませんか）',
  'non-ascii':
    '印字可能 ASCII 以外を含みます（説明文の貼り付けが疑われます。空白・全角も不可）',
};

/**
 * 値が「明らかにその値ではない」かを判定する。正当なら `null`。
 *
 * 🔴 **値そのものを返さない。** 呼び出し側は理由だけを診断に出す ――
 * 「短すぎる」で弾かれるのは**本物の secret でありうる**ので、載せれば漏れる。
 */
function classifyInvalid(_envVar: string, contextKey: string, value: string): InvalidReason | null {
  if (contextKey === 'providerSecretBackend' && !PROVIDER_SECRET_BACKENDS.includes(value)) {
    return 'vocabulary';
  }
  if (PLACEHOLDER_BRACKETS.test(value)) return 'placeholder';
  if (NON_PRINTABLE_ASCII.test(value)) return 'non-ascii';
  return null;
}

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
 * 🔴 **診断に値を載せない。** 現在は名前/URL/語彙だけだが、将来 secret が混ざっても
 * 診断経路から値を漏らさない不変条件は維持する。
 */
export function resolveDeployContext(
  env: Readonly<Record<string, string | undefined>>,
): DeployContextResult {
  const missing: string[] = [];
  const invalidReasons: Array<readonly [envVar: string, reason: InvalidReason]> = [];
  const args: string[] = [];

  for (const [envVar, contextKey] of REQUIRED) {
    const raw = env[envVar];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      missing.push(envVar);
      continue;
    }
    const reason = classifyInvalid(envVar, contextKey, value);
    if (reason !== null) {
      invalidReasons.push([envVar, reason]);
      continue;
    }
    args.push('-c', `${contextKey}=${value}`);
    // #1148: origin-verify は app secret と同じ Secrets Manager secret の
    // ORIGIN_VERIFY_SECRET キーを使う。名前を二重設定させず、同じ値から両 context を生成する。
    if (envVar === 'OR_APP_SECRETS_NAME') {
      args.push('-c', `originVerifySecretName=${value}`);
    }
  }

  const invalid = invalidReasons.map(([envVar]) => envVar);

  if (invalid.length > 0) {
    const reasons = new Set(invalidReasons.map(([, reason]) => reason));
    return {
      ok: false,
      missing,
      invalid,
      message: [
        'デプロイ context の値が不正です:',
        // 🔴 値そのものは載せない（必須変数は秘密を運ぶ。ここだけ例外にすると型が崩れる）。
        ...invalidReasons.map(([envVar, reason]) => `  ${envVar}  →  ${REASON_HINT[reason]}`),
        '',
        ...(reasons.has('vocabulary')
          ? [
              '綴り違いは web-stack の判定に一致せず、静かに in-memory へ倒れます。',
              '設定したつもりで揮発するので、ここで止めます。',
            ]
          : []),
        ...(reasons.has('placeholder') || reasons.has('non-ascii')
          ? [
              'runbook の説明文や全角値を context として貼る事故を防ぐため、ここで止めます。',
              '値は docs/runbook-cloud-aws-deploy.md を参照してください（リポジトリには置きません）。',
            ]
          : []),
      ].join('\n'),
    };
  }

  if (missing.length > 0) {
    const lines = REQUIRED.filter(([envVar]) => missing.includes(envVar)).map(
      ([envVar, contextKey, why]) =>
        envVar === 'OR_APP_SECRETS_NAME'
          ? `  ${envVar}  →  -c ${contextKey}=... + -c originVerifySecretName=...   （${why}）`
          : `  ${envVar}  →  -c ${contextKey}=...   （${why}）`,
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

/**
 * 窓を開けるときに貼る `KEY=VALUE` ブロックを組み立てる。
 *
 * 🔴 **これは既定の挙動で、専用のフラグは無い。** オプトアウトが `--no-context` である。
 * 以前ここは同梱を表す独自フラグ（`with-context`）を名乗っていたが、そんなフラグは実装に
 * 無く、この散文を信じた案内が `未知の引数` を踏ませた（2026-09-14）。フラグ名の実在は
 * `tests/hooks/aws-issue-credentials.test.ts` が実装の `case` 節と突き合わせて縛る。
 *
 * 🔴 **実在しないフラグを二重ダッシュ付きで書かない。** 上の由来でダッシュを外しているのは
 * 表記の揺れではなく、検査がそれを「名乗っている」と読むため。二重ダッシュ形は
 * **実在するフラグのために取っておく。**
 *
 * ## なぜ要るか
 *
 * #989 で AWS 5 変数と deploy context を一括で運ぶようにした。
 * #1148 では origin-verify の**生 secret 値**を handoff から削除し、
 * `OR_APP_SECRETS_NAME` から `appSecretsName` と `originVerifySecretName` の両方を
 * 決定論的に生成する。必須 deploy context は 4 → 3 変数になり、設定ドリフトも減る。
 *
 * 判定は `resolveDeployContext` と**同じ**（欠落・語彙外を同じ基準で弾く）。窓を開けてから
 * `diff` で気づくのでは、その往復ぶん窓を食う ―― **窓を開ける前に落とす**のが要点である。
 */
export type DeployContextEnvBlockResult =
  | { readonly ok: true; readonly block: string }
  | {
      readonly ok: false;
      readonly missing: ReadonlyArray<string>;
      readonly invalid: ReadonlyArray<string>;
      readonly message: string;
    };

export function resolveDeployContextEnvBlock(
  env: Readonly<Record<string, string | undefined>>,
): DeployContextEnvBlockResult {
  const resolved = resolveDeployContext(env);
  if (!resolved.ok) return resolved;

  // 独自ドメイン（#189）は**任意**だが、窓を開けるときに運ばれないと
  // **黙って CDK 生成ドメインのままデプロイされる**（#989 と同じ「1 つだけ貼り忘れ」の型）。
  // 設定されているなら運び、形が不正なら**窓を開ける前に**落とす。
  const customDomain = resolveCustomDomainContext(env.OR_CUSTOM_DOMAIN);
  if (!customDomain.ok) {
    return { ok: false, missing: [], invalid: ['OR_CUSTOM_DOMAIN'], message: customDomain.message };
  }

  // `resolveDeployContext` が ok を返した時点で全キーが揃い、語彙も検証済み。
  // 値の正規化（trim）もそちらに揃えたいので、env から読み直さずに同じ手順を踏む。
  const lines = REQUIRED.map(([envVar]) => `${envVar}=${(env[envVar] ?? '').trim()}`);
  // args が空＝「使わない」。その場合はブロックへ足さず、既存の 4 行のままにする。
  if (customDomain.args.length > 0) {
    lines.push(`OR_CUSTOM_DOMAIN=${(env.OR_CUSTOM_DOMAIN ?? '').trim()}`);
  }
  return { ok: true, block: lines.join('\n') };
}

/**
 * `KEY=VALUE` 形式のローカルファイルを読む（既定は**リポジトリの外**に置く）。
 *
 * 既定の置き場所は作業ツリーの外（`~/.config/open-reception/deploy-context.env`）。
 * #1148 で origin-verify の生 secret はこのファイルからも消えるが、運用 context を
 * リポジトリへ混ぜない境界は維持する。
 *
 * dotenv の完全実装ではない。**貼り付け事故の吸収**だけを担う:
 * 前後の空白、行頭 `#` のコメント、値を丸ごと囲んだ引用符。
 * 値の中の `=` は保つ（base64 の padding が入りうる）。
 */
export function parseDeployContextFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();
    // 両端が同じ引用符で囲われているときだけ外す（片側だけなら値の一部とみなす）。
    if (value.length >= 2) {
      const head = value[0];
      if ((head === '"' || head === "'") && value.endsWith(head)) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
