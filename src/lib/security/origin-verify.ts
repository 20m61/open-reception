/**
 * CloudFront 経由アクセスの検証 (#612 / OAC POST 署名問題の回避方式)。
 *
 * CloudFront OAC は Lambda Function URL への POST でボディを署名しないため、Function URL 側の
 * SigV4 検証が必ず失敗する（GET は 200・POST は 403）。回避策として Function URL を
 * `authType=NONE` で公開し、CloudFront が origin custom header `x-origin-verify` に
 * 高エントロピーのシークレットを付与する。middleware がこれを照合して直叩きを拒否する。
 *
 * 判定を純関数へ切り出しているのは、**fail-open / fail-closed の分岐をテストで固定する**ため。
 *
 * **検証の ON/OFF は `ORIGIN_VERIFY_REQUIRED`（非機密フラグ）だけが決める。**
 * シークレットの有無では決めない。理由は 2 つある。
 *
 * 1. 「シークレットが無ければ検証しない」だと、解決に失敗したときにも成立してしまい、
 *    そのとき CloudFront 迂回が全ルートで素通りする（#612 の runtime 解決案で実際に踏みかけた分岐。
 *    `main` の生値方式では CDK が同じ値をヘッダと env へ 1 箇所で書くので到達しなかった）。
 * 2. 逆に「シークレットが在れば検証する」だと、`appSecretsName` の JSON に
 *    `ORIGIN_VERIFY_SECRET` を同居させた配備で `-c originVerifySecretName=` を渡し忘れたとき、
 *    **CloudFront はヘッダを送らないのに Lambda 側だけ値を持つ**状態になり全ルートが 403 になる。
 *    シークレットの存在は「この配備が origin-verify 方式か」の証拠にならない。
 *
 * よって配備側（CDK）が方式を明示的に表明し、アプリはそれだけを見る。
 */

/** CloudFront が付与する origin custom header 名。CDK 側と同じ値であること。 */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

/** 解決済みシークレットを載せる env 名。Secrets Manager 方式では instrumentation が流し込む。 */
export const ORIGIN_VERIFY_SECRET_ENV = 'ORIGIN_VERIFY_SECRET';

/** origin-verify 方式で配備されていることの表明（値は機密でない）。 */
export const ORIGIN_VERIFY_REQUIRED_ENV = 'ORIGIN_VERIFY_REQUIRED';

/**
 * 拒否ログの先頭マーカー (#630)。
 *
 * **CloudWatch Logs のメトリクスフィルタがこの文字列で検索する**ため、アプリと CDK が
 * 同じ定数を使う。ログ文言を書き換えるとアラームが**黙って鳴らなくなる**のが最大のリスクで、
 * 文字列を 2 箇所に持つとそれが起こる（同じ構図で #634 は「npm script を差し替えたのに
 * ゲートは直呼びのまま」を踏んだ）。構造上ずれないように 1 箇所へ置く。
 *
 * 値そのものは機密でない（理由の種別だけで、シークレットは一切含まない）。
 */
export const ORIGIN_VERIFY_LOG_MARKERS = {
  /** 配備側の自損。全リクエストが 503。**1 度でも出たら異常**。 */
  missingSecret: '[origin-verify] ORIGIN_VERIFY_REQUIRED is set',
  /** 直叩き（正常）または ローテーションずれ（全断）。403。 */
  mismatch: '[origin-verify] header mismatch',
} as const;

export type OriginVerifyConfig = {
  /** CloudFront が付与する想定のシークレット。未解決なら undefined。 */
  readonly secret: string | undefined;
  /** この配備が origin-verify 方式であることの表明。 */
  readonly required: boolean;
};

export type OriginVerifyOutcome =
  | { readonly ok: true; readonly reason: 'disabled' | 'matched' }
  | { readonly ok: false; readonly reason: 'missing-secret' | 'mismatch' };

/**
 * 未置換の CFN 動的参照。CloudFormation が解決に失敗するとこの**リテラル**が
 * CloudFront ヘッダにも Lambda env にも入る。両側が同じ文字列なので `matched` になり、
 * **テンプレートから導ける公開文字列が共有シークレットになる**（＝防御ゼロ）のに、
 * システムは完全に健康だと報告する。解決失敗として扱い fail-closed に倒す。
 */
const UNRESOLVED_DYNAMIC_REFERENCE = '{{resolve:';

export function readOriginVerifyConfig(env: Record<string, string | undefined>): OriginVerifyConfig {
  // 空白のみは「解決できなかった」。Secrets Manager の JSON 値が `'   '` でも通さない。
  const raw = env[ORIGIN_VERIFY_SECRET_ENV]?.trim();
  const required = env[ORIGIN_VERIFY_REQUIRED_ENV];
  return {
    // 空文字は「解決できなかった」であって「空のシークレットと一致すべき」ではない。
    secret: raw && !raw.startsWith(UNRESOLVED_DYNAMIC_REFERENCE) ? raw : undefined,
    required: Boolean(required) && required !== '0',
  };
}

export function evaluateOriginVerify(
  config: OriginVerifyConfig,
  headerValue: string | null | undefined,
): OriginVerifyOutcome {
  // 方式を表明していない配備（OAC / ローカル）では、シークレットが env に紛れ込んでいても検証しない。
  // CloudFront がヘッダを送らないので、ここで検証すると全リクエストが 403 になる。
  if (!config.required) return { ok: true, reason: 'disabled' };

  // 方式を表明しているのに値が無い＝解決に失敗している。通すと迂回が全ルートで素通りする。
  // これは「拒否すべきリクエスト」ではなく**配備側の障害**なので、呼び出し側は 5xx を返す。
  if (!config.secret) return { ok: false, reason: 'missing-secret' };

  // シークレットは高エントロピーのため単純比較で十分（タイミング攻撃は非現実的）。
  return headerValue === config.secret
    ? { ok: true, reason: 'matched' }
    : { ok: false, reason: 'mismatch' };
}
