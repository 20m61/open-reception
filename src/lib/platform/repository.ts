/**
 * platform 運用レコード群のリポジトリ (issue #274 ③)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: interface + getBackend()
 * （DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ。
 * 各 `*-store.ts` はプロセス共有ファクトリ + 互換 API（seed 定義・入力前提のドキュメント）を
 * 担い、呼び出し側 route の変更は不要。
 *
 * - 運用レコード 4 種（incident / notice / maintenance-window / update-status）は
 *   list/create/reset の同型契約のため、汎用 interface `PlatformRecordRepository<T>` に束ねる。
 *   一覧上限は PLATFORM_LIST_LIMIT（store-limits.ts）で共通。
 * - feature-flag は 1 テナント 1 レコード（id = tenantId）の get/put/list。
 * - elevation-jti はセキュリティ経路（#264/#278）。fail-closed / updateIf CAS / 冪等 revoke の
 *   挙動・原子性を**変えない**こと（契約は elevation-jti-store.test.ts が固定している）。
 */
import {
  elevationJtiStatus,
  ELEVATION_MAX_TTL_MS,
  type ElevationJtiRecord,
  type ElevationJtiStatus,
} from '@/domain/auth/elevation';
import type { TenantFeatureFlagRecord } from '@/domain/platform/feature-flags';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import { PLATFORM_LIST_LIMIT } from './store-limits';

export const PLATFORM_INCIDENT_COLLECTION = 'platform_incidents';
export const PLATFORM_NOTICE_COLLECTION = 'platform_notices';
export const PLATFORM_MAINTENANCE_WINDOW_COLLECTION = 'platform_maintenance_windows';
export const PLATFORM_UPDATE_STATUS_COLLECTION = 'platform_update_status';
export const PLATFORM_FEATURE_FLAG_COLLECTION = 'platform_feature_flags';
export const PLATFORM_ELEVATION_JTI_COLLECTION = 'platform_elevation_jti';

/**
 * platform 運用レコード（incident / notice / maintenance-window / update-status）の共通契約。
 * 並べ替え・集計は domain の純関数（summarize*）に、書き込み前提（JIT 昇格ゲート + 監査）は
 * 呼び出し側 route に、それぞれ委譲する。
 */
export interface PlatformRecordRepository<T> {
  /** 全件を返す（PLATFORM_LIST_LIMIT 上限。超過分は warn つきで切り詰め）。 */
  list(): Promise<T[]>;
  /** 登録（作成または上書き。id は呼び出し側で採番済み）。 */
  create(record: T): Promise<void>;
  /** テスト/seed 用: seed 状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/**
 * getBackend() に永続化する運用レコードリポジトリ。
 * seed は memory backend のみ有効（dev/test/デモ）。dynamodb では無視され実データを正とする
 * （偽の「障害あり/なし」等を見せない）。
 */
export class DataBackedPlatformRecordRepository<T extends { id: string }>
  implements PlatformRecordRepository<T>
{
  private readonly col: () => Collection<T>;

  constructor(collectionName: string, seed?: () => T[]) {
    this.col = () => getBackend().collection<T>(collectionName, { seed });
  }

  async list(): Promise<T[]> {
    return this.col().list({ limit: PLATFORM_LIST_LIMIT });
  }

  async create(record: T): Promise<void> {
    await this.col().put(record);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}

/** テナント別機能フラグ（1 テナント 1 レコード、id = tenantId）の契約 (issue #83 inc5a)。 */
export interface TenantFeatureFlagRepository {
  /** テナントの上書きレコードを返す（未作成なら undefined = 全機能既定値）。 */
  getRecord(tenantId: string): Promise<TenantFeatureFlagRecord | undefined>;
  /** 全テナントの上書きレコードを返す（プラットフォーム横断サマリ用 read）。 */
  listRecords(): Promise<TenantFeatureFlagRecord[]>;
  /** 上書きレコードを保存する（呼び出し側で昇格ゲート + 監査を通した後に呼ぶ）。 */
  putRecord(record: TenantFeatureFlagRecord): Promise<void>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/** getBackend() に永続化する機能フラグリポジトリ。seed は置かない（既定値がデモ状態）。 */
export class DataBackedTenantFeatureFlagRepository implements TenantFeatureFlagRepository {
  private readonly col = () =>
    getBackend().collection<TenantFeatureFlagRecord>(PLATFORM_FEATURE_FLAG_COLLECTION);

  async getRecord(tenantId: string): Promise<TenantFeatureFlagRecord | undefined> {
    return this.col().get(tenantId);
  }

  async listRecords(): Promise<TenantFeatureFlagRecord[]> {
    return this.col().list({ limit: PLATFORM_LIST_LIMIT });
  }

  async putRecord(record: TenantFeatureFlagRecord): Promise<void> {
    await this.col().put(record);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}

// 掃除用 TTL: 昇格窓の上限（60 分）+ 余裕 1 時間。期限判定は expiresAt で行うため精度は不要。
const CLEANUP_TTL_SECONDS = Math.floor(ELEVATION_MAX_TTL_MS / 1000) + 60 * 60;

/**
 * JIT 昇格 jti の失効リポジトリ (issue #264 対応案 2)。
 * fail-closed（記録なし = unknown = 無効）と updateIf CAS による冪等 revoke が契約。
 * レコードは jti / sub / 期限のみで PII・token 平文は持たない。
 */
export interface ElevationJtiRepository {
  /** 発行した jti を記録する（昇格発行時に必ず呼ぶ。これが無い jti は assertElevated で拒否）。 */
  register(input: { jti: string; sub: string; expiresAt: number }): Promise<void>;
  /**
   * jti を明示失効する（期限前の取り消し）。冪等: 既に失効済みでも true（最初の revokedAt を保持）。
   * 未登録の jti は false（何もしない。元々 fail-closed で無効なので失効対象がない）。
   */
  revoke(jti: string, now: number): Promise<boolean>;
  /** jti の現在状態。判定は純関数 elevationJtiStatus（unknown = 記録なし = fail-closed で無効）。 */
  state(jti: string, now: number): Promise<ElevationJtiStatus>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/**
 * getBackend() に永続化する jti 失効リポジトリ。DynamoDB の実 TTL 設定はインフラ変更になるため
 * 使わず、読み取り時の期限判定（expiresAt）で無効化する。掃除用に `ttlSeconds` は付与しておく
 * （テーブルで TTL が有効化されればレコードが自動削除される。判定は読み時に行うので必須ではない）。
 */
export class DataBackedElevationJtiRepository implements ElevationJtiRepository {
  private readonly col = () =>
    getBackend().collection<ElevationJtiRecord>(PLATFORM_ELEVATION_JTI_COLLECTION, {
      ttlSeconds: CLEANUP_TTL_SECONDS,
    });

  async register(input: { jti: string; sub: string; expiresAt: number }): Promise<void> {
    await this.col().put({ id: input.jti, sub: input.sub, expiresAt: input.expiresAt });
  }

  async revoke(jti: string, now: number): Promise<boolean> {
    // revokedAt 未設定のときだけ刻む（atomic compare-and-set）。二重 end で失効時刻を上書きしない。
    const updated = await this.col().updateIf(jti, { revokedAt: now }, { revokedAt: undefined });
    if (updated) return true;
    // updateIf false = 「未登録」か「既に失効済み」。既に失効済みなら冪等に true を返す。
    const existing = await this.col().get(jti);
    return existing !== undefined && existing.revokedAt !== undefined;
  }

  async state(jti: string, now: number): Promise<ElevationJtiStatus> {
    const record = await this.col().get(jti);
    return elevationJtiStatus(record, now);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}
