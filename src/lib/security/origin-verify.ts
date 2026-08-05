/**
 * CloudFront 経由アクセスの検証 (#612 / OAC POST 署名問題の回避方式)。
 *
 * CloudFront OAC は Lambda Function URL への POST でボディを署名しないため、Function URL 側の
 * SigV4 検証が必ず失敗する（GET は 200・POST は 403）。回避策として Function URL を
 * `authType=NONE` で公開し、CloudFront が origin custom header `x-origin-verify` に
 * 高エントロピーのシークレットを付与する。middleware がこれを照合して直叩きを拒否する。
 *
 * 判定を純関数へ切り出しているのは、**fail-open の分岐をテストで固定する**ため。
 * 「シークレットが未設定なら検証しない」という後方互換の分岐は、Secrets Manager からの
 * 解決に失敗したときにも成立してしまい、そのとき CloudFront 迂回が素通りする。
 * `ORIGIN_VERIFY_REQUIRED`（非機密フラグ）を配備側が立てることで、この 2 つを区別する。
 */

/** CloudFront が付与する origin custom header 名。CDK 側と同じ値であること。 */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

/** 解決済みシークレットを載せる env 名。Secrets Manager 方式では instrumentation が流し込む。 */
export const ORIGIN_VERIFY_SECRET_ENV = 'ORIGIN_VERIFY_SECRET';

/** origin-verify 方式で配備されていることの表明（値は機密でない）。 */
export const ORIGIN_VERIFY_REQUIRED_ENV = 'ORIGIN_VERIFY_REQUIRED';

export type OriginVerifyConfig = {
  /** CloudFront が付与する想定のシークレット。未解決なら undefined。 */
  readonly secret: string | undefined;
  /** この配備が origin-verify 方式であることの表明。 */
  readonly required: boolean;
};

export type OriginVerifyOutcome =
  | { readonly ok: true; readonly reason: 'disabled' | 'matched' }
  | { readonly ok: false; readonly reason: 'missing-secret' | 'mismatch' };

export function readOriginVerifyConfig(env: Record<string, string | undefined>): OriginVerifyConfig {
  const raw = env[ORIGIN_VERIFY_SECRET_ENV];
  const required = env[ORIGIN_VERIFY_REQUIRED_ENV];
  return {
    // 空文字は「解決できなかった」であって「空のシークレットと一致すべき」ではない。
    secret: raw ? raw : undefined,
    required: Boolean(required) && required !== '0',
  };
}

export function evaluateOriginVerify(
  config: OriginVerifyConfig,
  headerValue: string | null | undefined,
): OriginVerifyOutcome {
  if (!config.secret) {
    // 配備が origin-verify 方式だと表明しているのに値が無い＝解決に失敗している。
    // ここで通すと CloudFront 迂回が全ルートで素通りするので fail-closed にする。
    return config.required
      ? { ok: false, reason: 'missing-secret' }
      : { ok: true, reason: 'disabled' };
  }
  // シークレットは高エントロピーのため単純比較で十分（タイミング攻撃は非現実的）。
  return headerValue === config.secret
    ? { ok: true, reason: 'matched' }
    : { ok: false, reason: 'mismatch' };
}
