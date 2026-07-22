/**
 * テナント別 CCaaS プロバイダ設定のドメイン型 (issue #405 Inc1)。
 *
 * このモジュールは **client-safe**（'use client' から import してよい）。secret の値は一切扱わず、
 * 非秘密設定と secret の presence（set|missing）だけを表す。secret 値を保持する型・ストアは
 * server-only の `./secret` に分離する（AC3: client component から secret 値型を import 不可）。
 *
 * secret の値は設定ストアに保存しない（AC2）。TenantProviderConfig は非秘密設定のみを持ち、
 * secret は `TenantSecretStore`（`./secret`）に別管理して presence のみを参照する。
 */

/** 対応プロバイダ。将来 CCaaS を追加できる union（配列と型を単一の真実から導く）。 */
export const PROVIDER_IDS = ['mock', 'vonage'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** secret の存在状態。値そのものは決して露出しない（write-only）。 */
export type SecretPresence = 'set' | 'missing';

/**
 * テナント別プロバイダ設定（**永続化する非秘密設定のみ**）。secret の値・部分値は持たない（AC2）。
 * secret は `TenantSecretStore` で別管理し、ここでは presence（set|missing）を別途参照する。
 */
export type TenantProviderConfig = {
  /** 認可済みコンテキストから導出したテナント（クライアント指定は使わない, AC4）。 */
  tenantId: string;
  provider: ProviderId;
  enabled: boolean;
  /** 非秘密の接続識別子（例: Vonage application id）。 */
  applicationId?: string;
  /** 発信元番号（非秘密）。 */
  fromNumber?: string;
  /** 通知タイムアウト(ms)。 */
  timeoutMs?: number;
  updatedAt: string;
  /** 操作者識別子（監査・帰属用）。API/画面の射影には出さない。 */
  updatedBy: string;
};

/**
 * API/画面へ返す射影。非秘密設定 + secret presence のみ。secret 値・操作者識別子(updatedBy)は
 * 含めない（AC1: 値露出なし / 横断 read に操作者を載せない既存方針）。
 */
export type TenantProviderConfigView = {
  tenantId: string;
  provider: ProviderId;
  enabled: boolean;
  applicationId?: string;
  fromNumber?: string;
  timeoutMs?: number;
  secretPresence: SecretPresence;
  updatedAt: string;
};

/** 未知の provider を弾く型ガード（union 外は false）。 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** 設定 + presence を whitelist 射影へ変換する（secret 値・updatedBy を落とす）。 */
export function toProviderConfigView(
  config: TenantProviderConfig,
  presence: SecretPresence,
): TenantProviderConfigView {
  const view: TenantProviderConfigView = {
    tenantId: config.tenantId,
    provider: config.provider,
    enabled: config.enabled,
    secretPresence: presence,
    updatedAt: config.updatedAt,
  };
  if (config.applicationId !== undefined) view.applicationId = config.applicationId;
  if (config.fromNumber !== undefined) view.fromNumber = config.fromNumber;
  if (config.timeoutMs !== undefined) view.timeoutMs = config.timeoutMs;
  return view;
}
