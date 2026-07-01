/**
 * 通知サブシステム worker 側の型 (infra SPEC #32 / DESIGN #34)。
 *
 * 送受信で共有する wire schema（NotificationRequest 等）は #275 で
 * src/domain/notification/notify.ts に集約し、ここでは再輸出のみ行う
 * （定義箇所は domain の 1 箇所。参照同一性は
 * src/domain/notification/schema-consistency.test.ts で担保）。
 * worker 実装内部でのみ使う型（SiteConfig / VoiceSettings / AudioRef）は本モジュールに置く。
 *
 * NOTE: Lambda バンドル（infra/lib/constructs/notification-function.ts の esbuild）が
 * tsconfig paths に依存しないよう、domain へは相対 import で参照する。
 */
import type { NotificationTarget } from '../../domain/notification/notify';

export type {
  NotificationKind,
  NotificationTarget,
  NotificationRequest,
  NotificationStatus,
  NotificationResult,
} from '../../domain/notification/notify';

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
