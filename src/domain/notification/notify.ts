/**
 * 通知実行（/notify API）の共有 wire schema (infra SPEC #32 / DESIGN #34 / #275 で domain へ集約)。
 *
 * 拠点（受付/管理）からの通知リクエストを受け、テキストを音声化（Polly）して外部通知
 * （Vonage）へ接続するサブシステムの **送受信双方が共有する型**。送信側（アプリ本体の
 * CallAdapter 本番実装が /notify を呼ぶ想定）と受信側（src/server/notification の worker
 * Lambda）が同一定義を参照し、schema ドリフトを防ぐ。
 *
 * worker 実装内部でのみ使う型（SiteConfig / VoiceSettings / AudioRef）は
 * src/server/notification/types.ts に残す（責務分離）。
 */

/** 通知種別。拠点側の用途で分岐する。 */
export type NotificationKind = 'call' | 'announcement';

/** 外部通知先（電話番号・SIP・拠点内エンドポイント等を抽象化）。 */
export interface NotificationTarget {
  /** 通知先種別（電話/アプリ内/SIP 等）。 */
  type: 'phone' | 'sip' | 'app';
  /** 宛先（E.164 電話番号 / SIP URI / アプリ ID）。 */
  value: string;
}

/** 拠点からの通知リクエスト（API 入力）。 */
export interface NotificationRequest {
  /** 拠点識別子（authorizer で検証済みのものと突合）。 */
  siteId: string;
  /** 冪等キー。同一キーの重複実行を抑止する。 */
  requestId: string;
  kind: NotificationKind;
  /** 読み上げ/通知本文。PII を最小化すること。 */
  message: string;
  /** 任意。未指定なら拠点設定の既定通知先を使う。 */
  target?: NotificationTarget;
}

/** 通知結果の分類（既存 CallResult と整合: connected/timeout/failed）。 */
export type NotificationStatus = 'delivered' | 'timeout' | 'failed';

export interface NotificationResult {
  status: NotificationStatus;
  requestId: string;
  /** 音声化を行ったか（Polly 利用有無）。 */
  synthesized: boolean;
  /** failed/timeout 時の理由（ログ・代替導線判断用。PII を含めない）。 */
  reason?: string;
}
