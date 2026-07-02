/**
 * テナント別機能フラグのドメイン純ロジック (issue #83 inc5a)。
 *
 * 「テナントごとに利用できる機能を切り替える」（#83 背景）の中核データ。既定は全機能有効で、
 * テナント単位の上書き（無効化/再有効化）のみを保存する。変更は破壊的操作（#83 §1「機能制限の変更」）
 * のため、ルート側で JIT 昇格（assertElevated）+ 監査（feature_flag.updated, before/after つき）を強制する。
 *
 * このモジュールは I/O を持たない純関数のみ。永続化は `@/lib/platform/feature-flag-store`、
 * 認可・監査はルート（/api/platform/tenants/[tenantId]/feature-flags）が担う。
 * フラグの enforcement（無効テナントで実際に機能を止める）は後続増分で各機能側に接続する。
 */

/** テナント単位で切り替えられる機能フラグのキー（未知キーは parse で拒否する）。 */
export const TENANT_FEATURE_FLAG_KEYS = ['voiceSynthesis', 'avatarReception'] as const;
export type TenantFeatureFlagKey = (typeof TENANT_FEATURE_FLAG_KEYS)[number];

/** 表示ラベル（UI/監査の補助。PII・機微値ではない）。 */
export const TENANT_FEATURE_FLAG_LABELS: Record<TenantFeatureFlagKey, string> = {
  voiceSynthesis: '音声合成',
  avatarReception: 'VRM / アバター受付',
};

/** 既定値。上書きレコードが無いテナントは全機能有効（現行運用と同じ挙動）。 */
export const DEFAULT_TENANT_FEATURE_FLAGS: Record<TenantFeatureFlagKey, boolean> = {
  voiceSynthesis: true,
  avatarReception: true,
};

/**
 * テナント単位の上書きレコード（永続化の単位）。id = tenantId。
 * flags は上書きしたキーのみ持つ（欠落キーは既定値）。
 */
export type TenantFeatureFlagRecord = {
  /** tenantId をそのまま id に使う（1 テナント 1 レコード）。 */
  id: string;
  flags: Partial<Record<TenantFeatureFlagKey, boolean>>;
  updatedAt: string;
  /** 最終更新の操作者 identity（#264 帰属。監査が正、これは補助）。 */
  updatedBy?: string;
};

function isFlagKey(key: string): key is TenantFeatureFlagKey {
  return (TENANT_FEATURE_FLAG_KEYS as readonly string[]).includes(key);
}

export type FeatureFlagChanges = Partial<Record<TenantFeatureFlagKey, boolean>>;

type ParseResult = { ok: true; changes: FeatureFlagChanges } | { ok: false; error: string };

/**
 * PATCH body の `flags` を検証する。既知キー + boolean 値のみ受理し、未知キー（typo で意図しない
 * フラグを作らない）・非 boolean・空オブジェクトは拒否する。
 */
export function parseFeatureFlagChanges(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'flags must be an object of { <flagKey>: boolean }' };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: 'flags must contain at least one flag key' };
  }
  const changes: FeatureFlagChanges = {};
  for (const [key, value] of entries) {
    if (!isFlagKey(key)) {
      return { ok: false, error: `unknown flag key: ${key}` };
    }
    if (typeof value !== 'boolean') {
      return { ok: false, error: `flag value for ${key} must be boolean` };
    }
    changes[key] = value;
  }
  return { ok: true, changes };
}

/** 上書きレコード（未作成なら undefined）から全キーの実効値を解決する。 */
export function effectiveTenantFeatureFlags(
  record: TenantFeatureFlagRecord | undefined,
): Record<TenantFeatureFlagKey, boolean> {
  return { ...DEFAULT_TENANT_FEATURE_FLAGS, ...record?.flags };
}

export type ApplyResult = {
  /** 保存すべき次レコード（changedKeys が空なら保存不要）。 */
  next: TenantFeatureFlagRecord;
  /** 実効値が実際に変わったキー（no-op は含めない）。 */
  changedKeys: TenantFeatureFlagKey[];
  /** 監査ログ用 before/after（変更キーのみ・文字列化済み。機微値なし, #83 AC13）。 */
  before: Record<string, string>;
  after: Record<string, string>;
};

/**
 * 変更を現在レコードへ適用し、次レコードと監査用差分を導出する。
 * 実効値が変わらないキー（no-op）は changedKeys/before/after に含めない（監査ノイズを避ける）。
 */
export function applyFeatureFlagChanges(
  current: TenantFeatureFlagRecord | undefined,
  changes: FeatureFlagChanges,
  ctx: { tenantId: string; now: Date; operator: string },
): ApplyResult {
  const effective = effectiveTenantFeatureFlags(current);
  const changedKeys: TenantFeatureFlagKey[] = [];
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const key of TENANT_FEATURE_FLAG_KEYS) {
    const value = changes[key];
    if (value === undefined || value === effective[key]) continue;
    changedKeys.push(key);
    before[key] = String(effective[key]);
    after[key] = String(value);
  }
  const next: TenantFeatureFlagRecord = {
    id: ctx.tenantId,
    flags: { ...current?.flags, ...changes },
    updatedAt: ctx.now.toISOString(),
    updatedBy: ctx.operator,
  };
  return { next, changedKeys, before, after };
}
