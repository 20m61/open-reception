/**
 * 受付履歴・監査ログのリポジトリ (issue #274 ⑥)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の LogStore に委譲する実装を 1 つだけ持つ。
 * ログ導出（deriveReceptionLog）・監査エントリ組み立て・PII 最小化の前提は
 * reception-log-store.ts（互換 API）に残し、本ファイルは永続化の境界のみを担う。
 *
 * LogStore 契約（put / list / listSince / findBy）を素通しで維持する:
 *   - list / listSince は新しい順（timestampField 降順）。
 *   - listSince は `timestampField >= sinceIso`（含む）の範囲クエリ (issue #254)。全件走査を
 *     避けるダッシュボード集計経路のため、この契約は reception-log-repository.test.ts が固定する。
 *   - 全件 list は管理画面表示のみ（§9.3。境界化は移行増分で扱う）。
 */
import type { AuditLog, ReceptionLog } from '@/domain/reception/log';
import { getBackend } from '@/lib/data';
import type { LogStore } from '@/lib/data/backend';

export const RECEPTION_LOG_NAME = 'rcplog';
export const AUDIT_LOG_NAME = 'audit';

export interface ReceptionLogRepository {
  /** 追記（同一 id は置換。fallbackUsed の read-modify-write は呼び出し側の責務）。 */
  put(log: ReceptionLog): Promise<void>;
  /** 新しい順（createdAt 降順）で返す。 */
  list(): Promise<ReceptionLog[]>;
  /** `createdAt >= sinceIso`（含む）のみを新しい順で返す（#254 の範囲クエリ）。 */
  listSince(sinceIso: string): Promise<ReceptionLog[]>;
  /** receptionId 一致の最新 1 件（dynamo は GSI、memory は走査）。 */
  findByReceptionId(receptionId: string): Promise<ReceptionLog | undefined>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

export interface AuditLogRepository {
  /** 追記（同一 id は置換）。 */
  put(log: AuditLog): Promise<void>;
  /** 新しい順（at 降順）で返す。 */
  list(): Promise<AuditLog[]>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/** getBackend() の LogStore に永続化する受付履歴リポジトリ。 */
export class DataBackedReceptionLogRepository implements ReceptionLogRepository {
  private readonly store: () => LogStore<ReceptionLog> = () =>
    getBackend().log<ReceptionLog>(RECEPTION_LOG_NAME, {
      timestampField: 'createdAt',
      indexedField: 'receptionId',
    });

  async put(log: ReceptionLog): Promise<void> {
    await this.store().put(log);
  }

  async list(): Promise<ReceptionLog[]> {
    return this.store().list();
  }

  async listSince(sinceIso: string): Promise<ReceptionLog[]> {
    return this.store().listSince(sinceIso);
  }

  async findByReceptionId(receptionId: string): Promise<ReceptionLog | undefined> {
    return this.store().findBy('receptionId', receptionId);
  }

  async reset(): Promise<void> {
    await this.store().reset();
  }
}

/** getBackend() の LogStore に永続化する監査ログリポジトリ。 */
export class DataBackedAuditLogRepository implements AuditLogRepository {
  private readonly store: () => LogStore<AuditLog> = () =>
    getBackend().log<AuditLog>(AUDIT_LOG_NAME, { timestampField: 'at' });

  async put(log: AuditLog): Promise<void> {
    await this.store().put(log);
  }

  async list(): Promise<AuditLog[]> {
    return this.store().list();
  }

  async reset(): Promise<void> {
    await this.store().reset();
  }
}
