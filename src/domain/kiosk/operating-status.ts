/**
 * サービス営業状態（開店/閉店）の受け口 (issue #367 の kiosk 側表示レール)。
 *
 * 本モジュールは「表示のための受け口」だけを定義する。実際の営業時間ポリシー
 * （ServiceOperatingPolicy: 曜日・祝日・一時休業・タイムゾーン評価）の本実装は #367 で行い、
 * その評価結果を `KioskOperatingStatus` としてここへ注入する。
 *
 * fail-open 原則: 判定不能（未注入/不正値）は「営業状態不明」とし、通常受付を止めない
 * （`operatingStateOf` は undefined を返し、`resolveKioskMode` は out_of_hours を出さない）。
 *
 * PII/機密を持たない: 緊急連絡導線は表示ラベルのみを受け取り、実電話番号・担当者名などの
 * 連絡先実体はここに載せない（#367 で運用ポリシーに沿って解決する）。
 */
export type OperatingState = 'open' | 'closed';

export type KioskOperatingStatus = {
  /** 現在の営業状態。'closed' のとき待機画面を営業時間外表示に差し替える。 */
  state: OperatingState;
  /** 再開予定時刻（ISO8601）。表示枠に出す。欠落/不正時は汎用文言へフォールバック。 */
  reopenAt?: string;
  /**
   * 緊急連絡導線の表示ラベル（例: 「警備室内線」）。実連絡先・PII は含めない。
   * 未設定時はプレースホルダ文言を表示する（#367 で実導線を接続）。
   */
  emergencyContactLabel?: string;
};

const OPERATING_STATES: ReadonlySet<string> = new Set<OperatingState>(['open', 'closed']);

/** 注入された営業状態を判定材料へ写す。未注入/不正値は undefined（fail-open）。 */
export function operatingStateOf(status?: KioskOperatingStatus): OperatingState | undefined {
  if (!status || !OPERATING_STATES.has(status.state)) return undefined;
  return status.state;
}

/** 再開時刻 ISO8601 を epoch ms へ。欠落/空白/不正は null（汎用文言へフォールバック）。 */
export function parseReopenAt(iso?: string): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
