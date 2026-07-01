/**
 * JIT 昇格 jti の失効ストア (issue #264 対応案 2)。
 *
 * `platform_elevation` cookie は署名＋exp だけでは**発行後に取り消せない** bearer トークンになる。
 * 本ストアは発行した jti を短命レコードとして記録し、
 *   - `/api/platform/elevate/end` で `revokedAt` を刻むと**期限前でも即失効**できる、
 *   - `assertElevated` が毎回 state を照会し、失効済み/記録なし cookie を拒否する（**fail-closed**:
 *     記録の無い jti は unknown = 無効。署名鍵が漏れてもストアに発行記録の無い cookie は使えない）、
 * を実現する。失効判定そのものは純関数 `elevationJtiStatus`（domain/auth/elevation）に委譲する。
 *
 * 永続化は data backend の collection。DynamoDB の実 TTL 設定はインフラ変更になるため使わず、
 * 読み取り時の期限判定（expiresAt）で無効化する。掃除用に `ttlSeconds` は付与しておく（テーブルで
 * TTL が有効化されればレコードが自動削除される。判定は読み時に行うので有効化は必須ではない）。
 * レコードは jti / sub / 期限のみで PII・token 平文は持たない。
 */
import {
  elevationJtiStatus,
  ELEVATION_MAX_TTL_MS,
  type ElevationJtiRecord,
  type ElevationJtiStatus,
} from '@/domain/auth/elevation';
import { getBackend } from '@/lib/data';

// 掃除用 TTL: 昇格窓の上限（60 分）+ 余裕 1 時間。期限判定は expiresAt で行うため精度は不要。
const CLEANUP_TTL_SECONDS = Math.floor(ELEVATION_MAX_TTL_MS / 1000) + 60 * 60;

const collection = () =>
  getBackend().collection<ElevationJtiRecord>('platform_elevation_jti', {
    ttlSeconds: CLEANUP_TTL_SECONDS,
  });

/** 発行した jti を記録する（昇格発行時に必ず呼ぶ。これが無い jti は assertElevated で拒否される）。 */
export async function registerElevationJti(input: {
  jti: string;
  sub: string;
  expiresAt: number;
}): Promise<void> {
  await collection().put({ id: input.jti, sub: input.sub, expiresAt: input.expiresAt });
}

/**
 * jti を明示失効する（期限前の取り消し）。冪等: 既に失効済みでも true（最初の revokedAt を保持）。
 * 未登録の jti は false（何もしない。元々 fail-closed で無効なので失効対象がない）。
 */
export async function revokeElevationJti(jti: string, now: number): Promise<boolean> {
  // revokedAt 未設定のときだけ刻む（atomic compare-and-set）。二重 end で失効時刻を上書きしない。
  const updated = await collection().updateIf(jti, { revokedAt: now }, { revokedAt: undefined });
  if (updated) return true;
  // updateIf false = 「未登録」か「既に失効済み」。既に失効済みなら冪等に true を返す。
  const existing = await collection().get(jti);
  return existing !== undefined && existing.revokedAt !== undefined;
}

/** jti の現在状態。判定は純関数 elevationJtiStatus（unknown = 記録なし = fail-closed で無効）。 */
export async function elevationJtiState(jti: string, now: number): Promise<ElevationJtiStatus> {
  const record = await collection().get(jti);
  return elevationJtiStatus(record, now);
}

/** テスト用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetElevationJtis(): Promise<void> {
  await collection().reset();
}
