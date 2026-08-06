/**
 * provider の通話 ID → 受付 の相関 (issue #4 MVP 1)。
 *
 * webhook は **公開エンドポイント**で、URL に tenantId を出せない（出すと他テナントの URL を
 * 組み立てられる）。よって「この通話は誰のものか」はサーバ側で引く必要がある。
 *
 * 引く鍵は **署名済み本文に載る provider の通話 ID**。URL のクエリは署名（`payload_hash`）の
 * 対象外なので、正規の webhook を別の通話へ付け替えられる ── クエリを権威にしてはいけない。
 *
 * ここが持つのは「どの通話がどの受付か」と**取次の現在位置**（`RoutingPosition`）だけ。
 * 来訪者情報・電話番号・secret は持たない（受付側 / 設定側にある）。
 *
 * 永続化は他のリポジトリと同じ `getBackend()`（DATA_BACKEND=memory|dynamodb）へ委譲する。
 */
import type { RoutingPosition } from '@/domain/routing/resumable';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

const CALL_CORRELATION_COLLECTION = 'call-correlations';

/** 取次が進行中か、確定済みか。確定後の webhook で取次を進めないための材料。 */
export type CallCorrelationStatus = 'in_flight' | 'settled';

export type StoredCallCorrelation = {
  /** provider（Vonage）側の通話 ID。webhook 本文に載る値で、これが引く鍵。 */
  readonly providerCallId: string;
  readonly receptionId: string;
  readonly tenantId: string;
  readonly siteId: string;
  /** 取次の現在位置。webhook 1 件で 1 歩進めるために保存する。 */
  readonly position: RoutingPosition;
  readonly status: CallCorrelationStatus;
  readonly updatedAt: string;
};

export interface CallCorrelationRepository {
  get(providerCallId: string): Promise<StoredCallCorrelation | undefined>;
  /** 期待テナントと一致するときだけ返す。越境と不在を**同じ結果**（undefined）にする。 */
  getForTenant(providerCallId: string, tenantId: string): Promise<StoredCallCorrelation | undefined>;
  put(correlation: StoredCallCorrelation): Promise<void>;
}

export class DataBackedCallCorrelationRepository implements CallCorrelationRepository {
  private readonly col: () => Collection<StoredCallCorrelation & { id: string }>;

  constructor() {
    this.col = () =>
      getBackend().collection<StoredCallCorrelation & { id: string }>(CALL_CORRELATION_COLLECTION);
  }

  async get(providerCallId: string): Promise<StoredCallCorrelation | undefined> {
    return this.col().get(providerCallId);
  }

  /**
   * **越境と不在を区別させない。** 他テナントの通話 ID を投げて「在るが読めない」と
   * 分かると、受付の存在そのものが漏れる（通話 ID の総当たりで在庫を探れる）。
   */
  async getForTenant(
    providerCallId: string,
    tenantId: string,
  ): Promise<StoredCallCorrelation | undefined> {
    const found = await this.col().get(providerCallId);
    return found && found.tenantId === tenantId ? found : undefined;
  }

  async put(correlation: StoredCallCorrelation): Promise<void> {
    // backend は `id` をキーにするので provider 側の通話 ID をそのまま id にする。
    await this.col().put({ ...correlation, id: correlation.providerCallId });
  }
}

let repository: CallCorrelationRepository | undefined;

export function getCallCorrelationRepository(): CallCorrelationRepository {
  if (!repository) repository = new DataBackedCallCorrelationRepository();
  return repository;
}

/** テスト用にシングルトンを捨てる。 */
export function __resetCallCorrelationRepository(): void {
  repository = undefined;
}
