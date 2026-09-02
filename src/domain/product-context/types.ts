/**
 * 製品全体で共有するコンテキストと「実効キオスク構成」のドメイン型 (issue #419 / epic #418)。
 *
 * 課題（#419「現状課題」）:
 *   - `/platform` / `/admin` / プレビュー / `/kiosk` がテナント・拠点・端末を別々の方法で解決している
 *     （query 直読み・`resolveDefaultScope()` 固定・セッション任意など。`src/app/api/kiosk/*` 参照）。
 *   - キオスクが branding / voice / motions / signage などを個別に取得してローカル状態へ積み上げるため、
 *     「実際に適用された構成」を一括で確認できない。
 *
 * 本モジュールは **型と語彙だけ**を定義する（I/O なし・実配線なし）。#418 コメントの指示どおり、
 * 最初の PR は「型・resolver interface・越境防止契約テスト」までに閉じ、個別設定 API の互換
 * アダプタ化と `/api/configuration/effective` の実装は後続 increment で行う。
 *
 * ロール語彙は**新設しない**。`src/domain/tenant/types.ts` の `TenantRole` と
 * `src/domain/tenant/authorization.ts` の判定をそのまま正とする（重複定義を避ける）。
 */
import type { SiteId, TenantId, TenantRole } from '@/domain/tenant/types';

/** 製品の画面領域。同じ構成解決処理を、どの立場から呼んでいるかを表す。 */
export const PRODUCT_AREAS = ['platform', 'tenant', 'kiosk-preview', 'kiosk-runtime'] as const;
export type ProductArea = (typeof PRODUCT_AREAS)[number];

/** #419 の `ProductRole`。既存のテナントロール語彙をそのまま使う。 */
export type ProductRole = TenantRole;

/**
 * 解決済みの製品コンテキスト。**サーバ側で権威的に解決した結果のみ**をこの型にする。
 * クライアントが送った tenantId/siteId/kioskId をそのまま詰めてはならない
 * （`resolveProductContext` を必ず通す）。
 */
export type ProductContext = {
  actorId: string;
  role: ProductRole;
  area: ProductArea;
  tenantId?: TenantId;
  siteId?: SiteId;
  kioskId?: string;
  experienceVersionId?: string;
};

/** 構成のバージョン指定。端末実行時は published 固定（draft を配信しない）。 */
export type ConfigurationVersionSelector =
  | { kind: 'draft' }
  | { kind: 'published' }
  | { kind: 'pinned'; experienceVersionId: string };

/** 受付体験バージョンの同定情報。`EffectiveKioskConfiguration.version` に載る。 */
export type ExperienceVersionRef = {
  id: string;
  status: 'draft' | 'published';
  /** 単調増加。端末側の stale 検出に使う。 */
  revision: number;
  publishedAt?: string;
  /**
   * 版が固定した**内容の**指紋（`computeSectionsHash`）。端末はこれを heartbeat で報告し、
   * 管理側は公開版の同じ値と突き合わせて反映状況を判定する（#420 Inc3）。
   * `EffectiveKioskConfiguration.configHash` は context（端末 ID）を含むため端末ごとに違い、
   * 「期待値」を 1 つに決められない。用途を取り違えないこと。
   */
  contentHash?: string;
};

/**
 * 実効構成のセクション名。個別設定 API（`/api/kiosk/branding` 等）と 1:1 に対応させ、
 * 移行台帳（`docs/product-integration-plan.md`）の API migration matrix の行キーになる。
 */
export const CONFIGURATION_SECTIONS = [
  'operatingPolicy',
  'receptionFlow',
  'directory',
  'branding',
  'avatar',
  'motions',
  'voice',
  'languages',
  'signage',
  'integrations',
  'featureFlags',
] as const;
export type ConfigurationSectionName = (typeof CONFIGURATION_SECTIONS)[number];

/**
 * 各設定値の由来（#419 AC「各設定値の由来をデバッグ出力で確認できる」）。
 * `default` はストア未設定でコード既定へ落ちたことを示し、fallback 件数の観測に使う。
 */
export const CONFIGURATION_SOURCES = ['version', 'kiosk', 'site', 'tenant', 'default'] as const;
export type ConfigurationSource = (typeof CONFIGURATION_SOURCES)[number];

/** ローダが返す 1 セクション分の結果。値と由来を必ず対にする。 */
export type ConfigurationSectionResult<T = unknown> = {
  value: T;
  source: ConfigurationSource;
};

/**
 * 端末に実際に適用される構成の単一の真実源（#419）。
 *
 * 秘匿情報・サーバ専用設定・来訪者 PII を含めてはならない。これは規約ではなく
 * `payload-contract.ts` の検査で機械的に固定する（`.claude/rules/pii-secret-minimization.md`）。
 */
export type EffectiveKioskConfiguration = {
  context: {
    tenantId: TenantId;
    siteId: SiteId;
    kioskId: string;
  };
  version: ExperienceVersionRef;
  operatingPolicy: unknown;
  receptionFlow: unknown;
  directory: unknown;
  branding: unknown;
  avatar: unknown;
  motions: unknown;
  voice: unknown;
  languages: unknown;
  signage: unknown;
  integrations: unknown;
  featureFlags: unknown;
  /** セクションごとの由来。デバッグ出力・fallback 件数の観測に使う。 */
  provenance: Record<ConfigurationSectionName, ConfigurationSource>;
  /** 構成内容の指紋。プレビューと本番で同一 version なら一致する（#419 AC1）。 */
  configHash: string;
  /** 生成時刻（ISO8601）。`configHash` の入力には含めない。 */
  generatedAt: string;
};
