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

/**
 * `originVerifySecret` に要求する最小長。
 *
 * 128 bit を base64url で表す最小長（`ceil(128 / 6) = 22`）。現行 dev は 44 文字（32 バイト）。
 * **上げすぎない** ―― 運用者が選んだ正当な値を弾くと、このガード自体が deploy を止める。
 */
const ORIGIN_VERIFY_MIN_LENGTH = 22;

/**
 * 🔴 **「set されている」は「正しい値が入っている」ではない**（2026-09-06）。
 *
 * 4 回目のデプロイで `OR_ORIGIN_VERIFY_SECRET` に、**runbook の散文に出てくる
 * プレースホルダ文字列そのもの**（`＜実際の高エントロピー値＞`）が入っていた。
 * 上の presence / 空文字の判定は**堂々と通す**し、`verify` も `preflight` も緑、
 * `diff` gate の findings も事前に承認された形を満たしていた ―― **一段も止まらなかった**。
 *
 * 前段（未登録）とは症状が正反対である。あちらは大声で止まるが、こちらは
 * **全部緑のまま通過し、しかもデプロイ後もアプリは正常に動く**。CloudFront のヘッダと
 * ServerFn の env は同じ context から組み立てられるので、両方が同じプレースホルダになる。
 * 壊れないので運用でも気づけず、`src/lib/security/origin-verify.ts` は単純比較なので
 * **リポジトリの散文を読んだ者は誰でもヘッダを偽造して CloudFront を迂回できる**。
 *
 * そこで presence だけでなく**値の見た目**も見る。判定は「明らかにその値ではない」形に
 * 限る ―― 強度を測るのではなく、**説明文の貼り付けを落とす**のが目的である。
 */
type InvalidReason = 'vocabulary' | 'placeholder' | 'non-ascii' | 'too-short';

/** 山括弧（ASCII / 全角）。この 4 変数の正当な値に山括弧は現れない。 */
const PLACEHOLDER_BRACKETS = /[<>＜＞]/u;

/**
 * 印字可能 ASCII 以外（空白・制御文字・全角を含む）。
 *
 * `x-origin-verify` は **HTTP ヘッダ値**なので非 ASCII をそもそも載せられない
 * （RFC 9110 field value）。他の 3 つも Secrets Manager 名・URL・語彙であり、
 * 非 ASCII が入る余地は「説明文を貼った」以外にない。
 */
const NON_PRINTABLE_ASCII = /[^\x21-\x7e]/u;

const REASON_HINT: Readonly<Record<InvalidReason, string>> = {
  vocabulary: `${PROVIDER_SECRET_BACKENDS.join(' | ')} のいずれか`,
  placeholder: '山括弧つきのプレースホルダのままです（runbook の記法をそのまま貼っていませんか）',
  'non-ascii':
    '印字可能 ASCII 以外を含みます（説明文の貼り付けが疑われます。空白・全角も不可）',
  'too-short': `${ORIGIN_VERIFY_MIN_LENGTH} 文字以上が必要です（128 bit 未満）`,
};

/**
 * 値が「明らかにその値ではない」かを判定する。正当なら `null`。
 *
 * 🔴 **値そのものを返さない。** 呼び出し側は理由だけを診断に出す ――
 * 「短すぎる」で弾かれるのは**本物の secret でありうる**ので、載せれば漏れる。
 */
function classifyInvalid(envVar: string, contextKey: string, value: string): InvalidReason | null {
  if (contextKey === 'providerSecretBackend' && !PROVIDER_SECRET_BACKENDS.includes(value)) {
    return 'vocabulary';
  }
  if (PLACEHOLDER_BRACKETS.test(value)) return 'placeholder';
  if (NON_PRINTABLE_ASCII.test(value)) return 'non-ascii';
  if (envVar === 'OR_ORIGIN_VERIFY_SECRET' && value.length < ORIGIN_VERIFY_MIN_LENGTH) {
    return 'too-short';
  }
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
 * 🔴 **診断に値を載せない。** `originVerifySecret` は秘密そのもの。変数名だけを出す。
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
        ...(reasons.has('placeholder') || reasons.has('non-ascii') || reasons.has('too-short')
          ? [
              '2026-09-06 に、runbook の説明文をそのまま貼った値で deploy 直前まで進みました。',
              'この型はデプロイしても壊れず（ヘッダと env が同じ値になる）、運用では気づけません。',
              '値は docs/runbook-cloud-aws-deploy.md を参照してください（リポジトリには置きません）。',
            ]
          : []),
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

/**
 * 窓を開けるときに貼る `KEY=VALUE` ブロックを組み立てる（`--with-context`）。
 *
 * ## なぜ要るか
 *
 * 環境ダイアログへ登録するのは **9 変数**（AWS の 5 つ ＋ デプロイ context の 4 つ）だが、
 * `aws-issue-credentials.sh` がクリップボードへ入れていたのは **AWS の 5 つだけ**だった。
 * 残り 4 つは「リポジトリに書いてあるから後で」になり、2026-09-06 の 3 回目のデプロイでは
 * **`OR_APP_SECRETS_NAME` だけが未登録**のまま窓を開けてしまい、`diff` が止まった（#989）。
 *
 * 落ちたのは 4 つのうち唯一「秘密の値ではない」もので、**秘密 3 つは貼る意識が働くのに
 * 非秘密の 1 つだけ抜ける**という形だった。9 つまとめて 1 回のコピーにすれば、
 * 「一部だけ貼る」余地そのものが消える。
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
  // `resolveDeployContext` が ok を返した時点で全キーが揃い、語彙も検証済み。
  // 値の正規化（trim）もそちらに揃えたいので、env から読み直さずに同じ手順を踏む。
  const block = REQUIRED.map(([envVar]) => `${envVar}=${(env[envVar] ?? '').trim()}`).join('\n');
  return { ok: true, block };
}

/**
 * `KEY=VALUE` 形式のローカルファイルを読む（既定は**リポジトリの外**に置く）。
 *
 * 🔴 **リポジトリ内に置かせない。** `OR_ORIGIN_VERIFY_SECRET` は秘密の値そのものなので、
 * 既定の置き場所を作業ツリーの外（`~/.config/open-reception/deploy-context.env`）にしてある。
 * `.gitignore` に頼ると、ignore 行を消した瞬間に秘密が commit され得る。
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
