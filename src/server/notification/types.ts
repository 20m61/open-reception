/**
 * 通知サブシステムのドメイン型 (infra SPEC #32 / DESIGN #34)。
 *
 * 拠点（受付/管理）からの通知リクエストを受け、テキストを音声化（Polly）して
 * 外部通知（Vonage）へ接続する。アプリ本体の CallAdapter (#4/#20) の本番実装が
 * この通知 API を呼ぶ想定。
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

/** 拠点ごとの設定（SSM / DynamoDB から取得）。 */
export interface SiteConfig {
  siteId: string;
  /** 有効な拠点か。失効拠点は通知を受け付けない（kiosk 失効 #18 と整合）。 */
  enabled: boolean;
  /** 既定の通知先（リクエストで target 未指定時に使用）。 */
  defaultTarget?: NotificationTarget;
  /** 音声設定（Polly）。 */
  voice: VoiceSettings;
}

/** Polly 音声設定。 */
export interface VoiceSettings {
  /** Polly voiceId（例: 'Mizuki' / 'Takumi'）。 */
  voiceId: string;
  /** 言語コード（例: 'ja-JP'）。 */
  languageCode: string;
  /** ニューラルエンジンを使うか。 */
  engine: 'standard' | 'neural';
}

/** 音声化結果の参照（音声バイト or 保存先）。 */
export interface AudioRef {
  /** 音声フォーマット（例: 'mp3'）。 */
  format: string;
  /** base64 音声データ（小サイズ通知向け）。大きい場合は url を使う設計余地を残す。 */
  base64?: string;
  /** 保存先 URL（将来 S3 等に保存する場合）。 */
  url?: string;
}
