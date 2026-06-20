/**
 * QR スキャナの注入可能 interface (issue #98, increment 1)。
 *
 * 受付端末のカメラ読み取りは実機・実デコードライブラリ前提（#65 / increment 2）。
 * inc1 では実デコードを抽象化し、フロー・エラー・確認画面を mock 実装で完成させる。
 * 実カメラ + デコード（@zxing 等）の採用は increment 2 で interface を変えずに差し替える。
 *
 * カメラ映像はローカル処理・非保存（録画 / 画像保存 / スクリーンショット保存をしない）。
 */

/** 読み取り中に起き得るエラー種別（UI が文言を出し分ける）。 */
export type ScanErrorKind =
  /** カメラ権限が拒否された / 取得できない。通常受付へフォールバック可能。 */
  | 'camera_denied'
  /** デコード不能・不正な QR（読み取り失敗）。 */
  | 'decode_failed'
  /** 読み取りがタイムアウトした。 */
  | 'timeout';

export type ScanError = {
  kind: ScanErrorKind;
  message: string;
};

/**
 * QR スキャナ。UI へ注入する。
 *
 * - start: 読み取りを開始し、検出ごとに onResult（生のテキスト = QR payload）を呼ぶ。
 *          回復不能なエラーは onError を呼ぶ。
 * - stop:  読み取りを停止し、カメラ等のリソースを解放する（画面離脱・確認遷移時に必ず呼ぶ）。
 */
export interface QrScanner {
  start(onResult: (text: string) => void, onError: (error: ScanError) => void): Promise<void>;
  stop(): Promise<void>;
}
