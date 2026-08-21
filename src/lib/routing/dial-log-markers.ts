/**
 * 取次まわりのログマーカー (#764)。
 *
 * **CloudWatch Logs のメトリクスフィルタがこの文字列で検索する**ため、アプリと CDK が
 * 同じ定数を使う。ログ文言を書き換えるとアラームが**黙って鳴らなくなる**のが最大のリスクで、
 * 文字列を 2 箇所に持つとそれが起こる（`ORIGIN_VERIFY_LOG_MARKERS` と同じ理由・同じ型）。
 *
 * 値そのものは機密でない（事象の種別だけで、番号・secret・PII を一切含まない）。
 */
export const KIOSK_DIAL_LOG_MARKERS = {
  /**
   * 実発信を意図しているテナントで取り次げなかった。**1 度でも出たら来訪者が
   * 追い返されている**（設定不備・ルート未作成・設定ストア障害のいずれか）。
   */
  realDialingUnavailable: 'kiosk_real_dialing_unavailable',
} as const;
