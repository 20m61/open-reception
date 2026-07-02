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
  /**
   * break-glass（緊急権限, #83 §3）区分。通常昇格には存在しない（undefined）。後方互換:
   * 既存 cookie / 旧クレームはこのフィールドを持たず、非 break-glass として扱われる。
   */
  breakGlass?: true;
};

/** 昇格 TTL の下限/上限/既定（#83: 15〜60分、既定 30分）。 */
export const ELEVATION_MIN_TTL_MS = 15 * 60 * 1000;
export const ELEVATION_MAX_TTL_MS = 60 * 60 * 1000;
export const ELEVATION_DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * break-glass の固定窓（#83 §3）。緊急権限は通常昇格（既定 30 分）より**短い 15 分固定**とする。
 * 障害対応が長引く場合は再発行させる（再発行ごとに理由 + 再認証 + 高重要度監査が残る）。
 */
export const BREAK_GLASS_TTL_MS = 15 * 60 * 1000;

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

/**
 * break-glass（緊急権限, #83 §3）を付与する純関数。通常昇格との違い:
 *   - 窓は **BREAK_GLASS_TTL_MS（15 分）固定**（呼び出し側が TTL を選べない・延長できない）。
 *   - `breakGlass: true` が立ち、発行・全 write・終了が高重要度監査の対象になる。
 * 強制の仕組み（sub 束縛・jti 失効・requireElevation）は通常昇格と同一で、分離は監査/UI 上の区分。
 */
export function grantBreakGlass(input: { reason: string; scope: ElevationScope }, now: number): Elevation {
  return { ...grantElevation({ ...input, ttlMs: BREAK_GLASS_TTL_MS }, now), breakGlass: true };
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
 * jti 失効ストアの 1 レコード (issue #264 対応案 2)。`id` = 発行 jti。
 * 発行時に短命ストアへ記録し、`/api/platform/elevate/end` 等で `revokedAt` を刻むと期限前でも失効する。
 */
export type ElevationJtiRecord = {
  id: string;
  /** 発行先の操作者 identity（cookie の sub と同値。失効操作の帰属確認に使う）。 */
  sub: string;
  /** 失効時刻（= Elevation.until, epoch ms）。ストア側の期限判定に使う。 */
  expiresAt: number;
  /** 明示失効（/elevate/end 等）の時刻。設定済みなら期限内でも無効。 */
  revokedAt?: number;
};

export type ElevationJtiStatus = 'active' | 'revoked' | 'expired' | 'unknown';

/**
 * jti 記録の失効判定（純関数）。**fail-closed**: 記録が無い jti は `unknown` を返し、呼び出し側は
 * 無効として扱う（署名鍵が漏れても、ストアに発行記録の無い cookie は使えない）。正規発行は必ず
 * 発行時に記録されるため、正常系で unknown にはならない。優先順位は revoked > expired
 * （明示失効の事実を期限経過で上書きしない）。
 */
export function elevationJtiStatus(
  record: ElevationJtiRecord | null | undefined,
  now: number,
): ElevationJtiStatus {
  if (!record) return 'unknown';
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.expiresAt <= now) return 'expired';
  return 'active';
}

/**
 * 昇格を監査メタdata（sanitize 済の `Record<string,string>`）へ射影する。
 * `privilege.elevated` 監査で使う。reason・対象スコープ・失効時刻のみ（機微値・PII は載せない）。
 */
export function elevationAuditMetadata(elevation: Elevation): Record<string, string> {
  const meta: Record<string, string> = {
    reason: elevation.reason,
    until: new Date(elevation.until).toISOString(),
    // break-glass は高重要度監査（#83 §3）。通常昇格には載せず既存の監査表現を変えない。
    ...elevatedWriteAuditMetadata(elevation),
  };
  if (elevation.scope.tenantId !== undefined) meta.tenantId = elevation.scope.tenantId;
  if (elevation.scope.siteId !== undefined) meta.siteId = elevation.scope.siteId;
  if (elevation.scope.deviceId !== undefined) meta.deviceId = elevation.scope.deviceId;
  return meta;
}

/**
 * 昇格中の write 監査へ merge する高重要度マーク（#83 §3）。break-glass 中は
 * `{ breakGlass:'true', severity:'high' }`、通常昇格は `{}`（既存の監査表現を変えない）。
 * platform の全 write（danger-create / tenant lifecycle 等）が metadata に spread して、
 * break-glass で行われた**すべての操作**を利用後レビューで抽出可能にする。
 */
export function elevatedWriteAuditMetadata(elevation: Elevation): Record<string, string> {
  return elevation.breakGlass ? { breakGlass: 'true', severity: 'high' } : {};
}

/**
 * 監査エントリが break-glass 関連（= 利用後レビュー対象, #83 §3）かの純判定。
 *   - 発行/終了: action `privilege.break_glass`。
 *   - break-glass 中の write: metadata.breakGlass === 'true'（elevatedWriteAuditMetadata で付与）。
 * 構造的型（action/metadata のみ）で受け、AuditLog 型へ依存しない。
 */
export function isBreakGlassAudit(entry: { action: string; metadata?: Record<string, string> }): boolean {
  return entry.action === 'privilege.break_glass' || entry.metadata?.breakGlass === 'true';
}
