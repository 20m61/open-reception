/**
 * 受付セッションのリポジトリ (issue #274 ⑤)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ。
 * 状態機械（transition）・呼び出し adapter・監査は reception-store.ts（互換 API）に残し、
 * 本ファイルは永続化の境界のみを担う。
 *
 * 受付セッションは短期失効（TTL）対象。id（randomUUID）でのみ引く短命データのため一覧 API は
 * 持たない（無境界 list を作らない）。
 */
import type { ReceptionSession } from '@/domain/reception/session';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

export const RECEPTION_COLLECTION = 'reception';

/** 既定 TTL（24 時間）。RECEPTION_SESSION_TTL_SEC 環境変数で上書きできる。 */
export const DEFAULT_RECEPTION_TTL_SEC = 24 * 60 * 60;

export interface ReceptionSessionRepository {
  get(id: string): Promise<ReceptionSession | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側の責務）。 */
  put(session: ReceptionSession): Promise<void>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/**
 * getBackend() に永続化する受付セッションリポジトリ。
 * TTL は dynamodb のみ実効（memory は無視）。env はアクセス時に評価する（テストでの上書き互換）。
 */
export class DataBackedReceptionSessionRepository implements ReceptionSessionRepository {
  private readonly col: () => Collection<ReceptionSession> = () =>
    getBackend().collection<ReceptionSession>(RECEPTION_COLLECTION, {
      ttlSeconds: Number(process.env.RECEPTION_SESSION_TTL_SEC) || DEFAULT_RECEPTION_TTL_SEC,
    });

  async get(id: string): Promise<ReceptionSession | undefined> {
    return this.col().get(id);
  }

  async put(session: ReceptionSession): Promise<void> {
    await this.col().put(session);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}
