/**
 * Just-in-Time 権限昇格（JIT elevation）の純ドメイン (issue #83 inc4 / #91)。
 *
 * 総合開発者（platform_developer = developer ロール）等の上位ロールでも、危険操作は常時許可
 * せず、**理由付き・対象スコープ限定・期限付きの一時昇格**を必須にする（#83 セキュリティ原則）。
 * 本モジュールは昇格の付与/有効判定/スコープ判定/監査メタdata 化を I/O 無しの純関数で表す。
 *
 * 保持: 昇格は既存の署名付き admin セッション（SessionPayload は拡張可能）に
 * `elevation` として載せる想定。サーバ側ストアは持たず、署名で改ざんを防ぐ。本増分（inc4a）は
 * 純ロジックと監査アクションの追加のみで、**破壊的操作は一切解禁しない**。
 *
 * セキュリティ: 昇格は最小権限・期限付き。失効後は自動的に読み取りへ戻る（呼び出し側が
 * requireElevation で判定）。reason は監査に残すが PII/機微値を書かない運用とする。
 */

/** 昇格/操作の対象スコープ。未指定（undefined）はワイルドカード（その階層を限定しない）。 */
export type ElevationScope = {
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
};

/** 一時昇格の付与内容。`until` は epoch ミリ秒。 */
export type Elevation = {
  /** 失効時刻（epoch ms）。これを過ぎたら無効。 */
  until: number;
  /** 操作理由（監査に残す。PII/機微値は書かない）。 */
  reason: string;
  /** 昇格が及ぶ対象スコープ。 */
  scope: ElevationScope;
};

/** 昇格 TTL の下限/上限/既定（#83: 15〜60分、既定 30分）。 */
export const ELEVATION_MIN_TTL_MS = 15 * 60 * 1000;
export const ELEVATION_MAX_TTL_MS = 60 * 60 * 1000;
export const ELEVATION_DEFAULT_TTL_MS = 30 * 60 * 1000;

/** requireElevation の判定結果。 */
export type ElevationCheck =
  | { ok: true }
  | { ok: false; reason: 'not_elevated' | 'expired' | 'out_of_scope' };

function clampTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return ELEVATION_DEFAULT_TTL_MS;
  return Math.min(ELEVATION_MAX_TTL_MS, Math.max(ELEVATION_MIN_TTL_MS, ttlMs));
}

/**
 * 一時昇格を付与する純関数。`now` は呼び出し側が渡す（テスト容易性）。
 * reason は必須（空白のみは不可）。ttl は [MIN, MAX] にクランプする。
 */
export function grantElevation(
  input: { reason: string; scope: ElevationScope; ttlMs?: number },
  now: number,
): Elevation {
  const reason = input.reason.trim();
  if (reason === '') throw new Error('elevation reason is required');
  const ttl = clampTtl(input.ttlMs ?? ELEVATION_DEFAULT_TTL_MS);
  return {
    until: now + ttl,
    reason,
    scope: {
      tenantId: input.scope.tenantId,
      siteId: input.scope.siteId,
      deviceId: input.scope.deviceId,
    },
  };
}

/** 昇格が現在有効か（失効していないか）。 */
export function isElevated(elevation: Elevation | null | undefined, now: number): boolean {
  return !!elevation && elevation.until > now;
}

/**
 * 昇格スコープが操作対象スコープを覆うか。
 * scope の各フィールドが undefined ならワイルドカード（その階層を限定しない）。
 * 値が設定されていれば target の同フィールドと一致が必要。
 * 例) platform 全体昇格 = {} は全対象を覆う。tenant 昇格 = {tenantId:'X'} は X のサイト/端末も覆う。
 */
export function elevationCoversScope(scope: ElevationScope, target: ElevationScope): boolean {
  if (scope.tenantId !== undefined && scope.tenantId !== target.tenantId) return false;
  if (scope.siteId !== undefined && scope.siteId !== target.siteId) return false;
  if (scope.deviceId !== undefined && scope.deviceId !== target.deviceId) return false;
  return true;
}

/**
 * 危険操作の昇格ガード。昇格が無い/失効/対象外を区別して返す。
 * 呼び出し側はこの結果で 403（理由付き）か実行かを決める。
 */
export function requireElevation(
  elevation: Elevation | null | undefined,
  target: ElevationScope,
  now: number,
): ElevationCheck {
  if (!elevation) return { ok: false, reason: 'not_elevated' };
  if (elevation.until <= now) return { ok: false, reason: 'expired' };
  if (!elevationCoversScope(elevation.scope, target)) return { ok: false, reason: 'out_of_scope' };
  return { ok: true };
}

/**
 * 昇格を監査メタdata（sanitize 済の `Record<string,string>`）へ射影する。
 * `privilege.elevated` 監査で使う。reason・対象スコープ・失効時刻のみ（機微値・PII は載せない）。
 */
export function elevationAuditMetadata(elevation: Elevation): Record<string, string> {
  const meta: Record<string, string> = {
    reason: elevation.reason,
    until: new Date(elevation.until).toISOString(),
  };
  if (elevation.scope.tenantId !== undefined) meta.tenantId = elevation.scope.tenantId;
  if (elevation.scope.siteId !== undefined) meta.siteId = elevation.scope.siteId;
  if (elevation.scope.deviceId !== undefined) meta.deviceId = elevation.scope.deviceId;
  return meta;
}
