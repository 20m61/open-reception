/**
 * 呼び出し先・通知ルート設定のドメイン型 (issue #88, increment 1 / #275 で domain へ集約)。
 *
 * 受付後に「誰へ・どの順番で・どの手段で」通知するかをテナント/サイト境界の中で管理する。
 * 通知実行ドメイン（./notify の NotificationRequest 等）とは責務が異なり、本モジュールは
 * **設定（ルート定義）** を扱う。実行サブシステムは将来この設定を解決して
 * NotificationRequest を組み立てる想定（docs/call-route-config-design.md）。
 *
 * 将来の拡張（メール/Slack/Teams/Web Push）に備え、通知手段は固定電話番号ではなく
 * NotificationChannel として抽象化する（issue #88 データモデル方針）。
 *
 * inc1 のスコープ:
 *   - CallRoute（ルート）の一覧・作成・編集・有効/無効を扱う。
 *   - CallTargetGroup > CallTarget の入れ子は CallRoute 内に値として保持する（最小実装）。
 *   - 機微値（電話番号・メール等の通知先 value）は監査に残さない（route 側で除外）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** ブランド付き ID。CallRoute の混在を型で防ぐ。 */
export type CallRouteId = string & { readonly __brand: 'CallRouteId' };
export const asCallRouteId = (v: string): CallRouteId => v as CallRouteId;

/**
 * 通知チャネル種別。電話に固定せず将来拡張する（issue #88 受け入れ条件）。
 * inc1 で UI から選べるのは phone / email だが、型は将来チャネルを含めて定義する。
 */
export const NOTIFICATION_CHANNELS = ['phone', 'email', 'slack', 'teams', 'webpush'] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannelKind(v: unknown): v is NotificationChannelKind {
  return typeof v === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(v);
}

/** 呼び出し先 1 件。担当者・グループの通知先を抽象化する。 */
export type CallTarget = {
  /** 表示名（例: 総務代表 / 山田）。PII を最小化し、氏名は表示名に閉じる。 */
  label: string;
  /** 通知チャネル種別。 */
  channel: NotificationChannelKind;
  /**
   * 宛先（E.164 電話番号 / メールアドレス / webhook 等）。機微情報。
   * 監査ログには残さない（route 側で除外）。
   */
  value: string;
  /** ルート内の呼び出し優先順位（小さいほど先）。 */
  priority: number;
};

/** 呼び出し先グループ。フォールバック順をまとめる単位（issue #88 データモデル）。 */
export type CallTargetGroup = {
  /** グループ表示名（例: 総務グループ）。 */
  label: string;
  /** グループ内の呼び出し先。priority 昇順に評価される想定。 */
  targets: CallTarget[];
};

/** 通知ルート。受付端末/拠点 → グループ → 呼び出し先 の対応を定義する。 */
export type CallRoute = {
  id: CallRouteId;
  tenantId: TenantId;
  /** 対象拠点。サイト境界認可（canAccessSite）の基準。 */
  siteId: SiteId;
  /** ルート表示名（例: 受付端末A 平日ルート）。 */
  name: string;
  /** 呼び出し先グループ（フォールバック順）。inc1 は 1 ルート複数グループを許容。 */
  groups: CallTargetGroup[];
  /** 有効/無効。無効ルートは解決対象外（運用停止）。 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 入力（作成）。id/タイムスタンプはサービスが採番する。 */
export type CreateCallRouteInput = {
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  groups?: CallTargetGroup[];
};

/** 更新パッチ。指定フィールドのみ反映する。 */
export type UpdateCallRoutePatch = {
  name?: string;
  groups?: CallTargetGroup[];
  enabled?: boolean;
};
