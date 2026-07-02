/**
 * JIT 昇格 jti の失効ストア (issue #264 対応案 2)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は ElevationJtiRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getElevationJtiRepository）と互換 API を担う。呼び出し側（elevation.ts / request.ts /
 * elevate/end route）の変更は不要。**挙動・原子性は不変**（fail-closed / updateIf CAS /
 * 冪等 revoke。契約は elevation-jti-store.test.ts が固定）。
 *
 * `platform_elevation` cookie は署名＋exp だけでは**発行後に取り消せない** bearer トークンになる。
 * 本ストアは発行した jti を短命レコードとして記録し、
 *   - `/api/platform/elevate/end` で `revokedAt` を刻むと**期限前でも即失効**できる、
 *   - `assertElevated` が毎回 state を照会し、失効済み/記録なし cookie を拒否する（**fail-closed**:
 *     記録の無い jti は unknown = 無効。署名鍵が漏れてもストアに発行記録の無い cookie は使えない）、
 * を実現する。失効判定そのものは純関数 `elevationJtiStatus`（domain/auth/elevation）に委譲する。
 * レコードは jti / sub / 期限のみで PII・token 平文は持たない。
 */
import type { ElevationJtiStatus } from '@/domain/auth/elevation';
import { DataBackedElevationJtiRepository, type ElevationJtiRepository } from './repository';

let repository: ElevationJtiRepository | undefined;

/** プロセス共有の ElevationJti リポジトリ（§9.2 のファクトリ）。 */
export function getElevationJtiRepository(): ElevationJtiRepository {
  if (!repository) {
    repository = new DataBackedElevationJtiRepository();
  }
  return repository;
}

/** 発行した jti を記録する（昇格発行時に必ず呼ぶ。これが無い jti は assertElevated で拒否される）。 */
export async function registerElevationJti(input: {
  jti: string;
  sub: string;
  expiresAt: number;
}): Promise<void> {
  await getElevationJtiRepository().register(input);
}

/**
 * jti を明示失効する（期限前の取り消し）。冪等: 既に失効済みでも true（最初の revokedAt を保持）。
 * 未登録の jti は false（何もしない。元々 fail-closed で無効なので失効対象がない）。
 */
export async function revokeElevationJti(jti: string, now: number): Promise<boolean> {
  return getElevationJtiRepository().revoke(jti, now);
}

/** jti の現在状態。判定は純関数 elevationJtiStatus（unknown = 記録なし = fail-closed で無効）。 */
export async function elevationJtiState(jti: string, now: number): Promise<ElevationJtiStatus> {
  return getElevationJtiRepository().state(jti, now);
}

/** テスト用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetElevationJtis(): Promise<void> {
  await getElevationJtiRepository().reset();
}
