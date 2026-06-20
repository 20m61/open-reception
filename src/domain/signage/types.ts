/**
 * 待機中サイネージモードのドメイン型 (issue #101, increment 1)。
 *
 * 受付端末が待機状態のとき、時計・案内文・画像・スライドショーなどを巡回表示する
 * サイネージの設定モデル。本増分は純粋なドメイン型と巡回ロジックのみを定義し、
 * 外部 I/O・実 DOM・presence 連携は持たない（配線は次増分）。
 *
 * 設計方針:
 *   - テナント/サイト境界は #80 の型（TenantId / SiteId）に乗せる。設定はサイト単位で 1 つ。
 *   - 表示するコンテンツに来訪者の PII を含めない（issue #101 セキュリティ方針）。
 *   - 外部画像/動画の素材ライセンスは #105 に従う。サンプルは自前プレースホルダのみ。
 *
 * このモジュールは純関数の土台。表示順序・巡回判定は src/domain/signage/rotation.ts、
 * 永続化は src/lib/signage/** が担う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** サイネージ項目の ID。設定内で項目を一意に識別する。 */
export type SignageItemId = string & { readonly __brand: 'SignageItemId' };
export const asSignageItemId = (v: string): SignageItemId => v as SignageItemId;

/**
 * 表示コンテンツの種別。
 * - clock:   時計（端末ローカル時刻を表示。外部素材・PII を要しない安全な既定）。
 * - message: 案内文（会社紹介・受付方法・緊急連絡先などの静的テキスト）。
 * - image:   画像 URL 1 枚（信頼できるオリジンのみ。ライセンスは #105）。
 * - slides:  画像 URL の連続表示（スライドショー）。
 */
export type SignageContentType = 'clock' | 'message' | 'image' | 'slides';

export const SIGNAGE_CONTENT_TYPES: readonly SignageContentType[] = [
  'clock',
  'message',
  'image',
  'slides',
];

export function isSignageContentType(v: unknown): v is SignageContentType {
  return typeof v === 'string' && (SIGNAGE_CONTENT_TYPES as readonly string[]).includes(v);
}

/**
 * サイネージ 1 項目。type ごとに使うフィールドが異なる（過不足は検証で弾く）。
 *
 * PII を含めない: message/imageAlt は運用者が用意する静的文言で、来訪者情報は載せない。
 */
export type SignageItem = {
  id: SignageItemId;
  type: SignageContentType;
  /** 個別の有効/無効。false の項目は巡回からも除外する。 */
  enabled: boolean;

  /** message 用の見出し（任意）。 */
  title?: string;
  /** message 用の本文。type='message' のとき必須。 */
  message?: string;

  /** image 用の URL。type='image' のとき必須。信頼できるオリジンのみ。 */
  imageUrl?: string;
  /** image/slides 用の代替テキスト（アクセシビリティ）。 */
  imageAlt?: string;

  /** slides 用の URL 配列。type='slides' のとき 1 つ以上必須。 */
  slideUrls?: string[];

  /**
   * この項目だけの表示秒数（任意）。未指定なら設定既定（defaultIntervalSeconds）を使う。
   * clock は時刻を更新し続けるため、通常は長めの値か既定で十分。
   */
  durationSeconds?: number;
};

/**
 * サイト単位のサイネージ設定。
 *
 * 1 サイトに 1 つ。getBackend の Singleton にサイトキー付きで保存する（src/lib/signage）。
 */
export type SignageConfig = {
  tenantId: TenantId;
  siteId: SiteId;

  /** サイネージモード全体の有効/無効。false なら待機画面はサイネージを出さない。 */
  enabled: boolean;

  /** 項目ごとに秒数未指定のときの既定表示間隔（秒）。 */
  defaultIntervalSeconds: number;

  /** 表示項目。配列の順序が巡回順序（rotation.ts はこの順序を尊重する）。 */
  items: SignageItem[];

  updatedAt: string;
};

/** 設定の制約値（検証・UI の両方で参照する単一の真実）。 */
export const SIGNAGE_LIMITS = {
  minIntervalSeconds: 3,
  maxIntervalSeconds: 600,
  maxItems: 30,
  maxSlidesPerItem: 50,
  maxMessageLength: 2000,
} as const;

/** 設定が未保存のときに使う安全な既定（時計のみ・無効）。 */
export function defaultSignageConfig(
  tenantId: TenantId,
  siteId: SiteId,
  now: string,
): SignageConfig {
  return {
    tenantId,
    siteId,
    enabled: false,
    defaultIntervalSeconds: 10,
    items: [],
    updatedAt: now,
  };
}
