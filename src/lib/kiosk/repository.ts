/**
 * 受付端末（旧 kiosk レジストリ #18）のリポジトリ (issue #274 ②)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ。
 * route / サービス（kiosk-store.ts の互換 API）は本 interface のみに依存し、collection 名や
 * 走査の詳細を知らない。
 *
 * 端末レジストリは構造的に小さい（拠点あたり数台）ため、list は既定上限（500, #274）で足りる。
 * kiosk レジストリ自体は Device（テナント境界つき source-of-truth）へ段階的に寄せる方針
 * （docs/site-device-management-design.md §Device/Kiosk 統合方針）。
 */
import type { Kiosk } from '@/domain/kiosk/types';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

export const KIOSK_COLLECTION = 'kiosk';

export interface KioskRepository {
  listKiosks(): Promise<Kiosk[]>;
  getKiosk(id: string): Promise<Kiosk | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側の責務）。 */
  putKiosk(kiosk: Kiosk): Promise<void>;
  /** テスト用: seed 状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/**
 * getBackend() に永続化する kiosk リポジトリ。
 * seed は memory backend のみ有効（dev/test/CI）。dynamodb では無視され実データを正とする。
 */
export class DataBackedKioskRepository implements KioskRepository {
  private readonly col: () => Collection<Kiosk>;

  constructor(seed?: () => Kiosk[]) {
    this.col = () => getBackend().collection<Kiosk>(KIOSK_COLLECTION, { seed });
  }

  async listKiosks(): Promise<Kiosk[]> {
    return this.col().list();
  }

  async getKiosk(id: string): Promise<Kiosk | undefined> {
    return this.col().get(id);
  }

  async putKiosk(kiosk: Kiosk): Promise<void> {
    await this.col().put(kiosk);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}
