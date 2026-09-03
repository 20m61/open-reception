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
import type { VoiceCallState } from '@/domain/call/voice-call-state';
import type { RoutingPosition } from '@/domain/routing/resumable';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

const CALL_CORRELATION_COLLECTION = 'call-correlations';

/**
 * 保存期間。通話 1 本の寿命しか意味を持たないレコードなので短く切る
 * （`CLAUDE.md` ガード「保存期間明示」。無期限だと単一 PK に無限に積む）。
 * 取次の最長（hop 上限 × 呼出タイムアウト）に対して十分な余裕を取った 6 時間。
 */
const CALL_CORRELATION_TTL_SECONDS = 6 * 60 * 60;

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
  /**
   * 通話の状態。**取次の位置とは別物**（位置＝どこまで撃ったか / 状態＝相手がどう応じたか）。
   *
   * これを保存しないと webhook のたびに `'queued'` から畳み直すことになり、
   * `applyVoiceEvent` の巻き戻し保護が消える（#4 Inc D-2。詳細は
   * `@/domain/routing/webhook-advance` の doc コメント）。
   *
   * **任意**にしてあるのは後方互換のため ── この項目が入る前に書かれたレコードには
   * 無い。読み側は `'queued'` を既定にする（TTL 6 時間なので旧レコードはすぐ消える）。
   */
  readonly voiceState?: VoiceCallState;
  /**
   * この通話で処理した webhook イベント数。
   *
   * 🔴 **上限判定の権威はここではない (#646)。** 上限は**取次全体**で効かせるので、
   * 数える値は `position.eventCount` に載っている。ここは `position` にそれを持たない
   * 旧レコードのための退避先で、TTL 6 時間で入れ替わるまでの互換用。
   * **任意**＝ voiceState と同じ後方互換の扱いで、読み側は 0 を既定にする。
   */
  readonly eventCount?: number;
  /**
   * この発信の呼出予算の期限（ISO） (#647)。
   *
   * webhook が一度も来ない場合（Vonage 側障害・署名失敗・相関不整合）でも、
   * `/status` の**読み時に遅延評価**して確定させるための材料。定期 sweeper を持たない
   * （継続的な AWS 費用を増やさない）ぶん、期限は発信時に置いておく必要がある。
   *
   * **任意**＝ `voiceState` と同じ後方互換の扱い。**無いことを「期限切れ」と読まないこと**
   * （鳴っている最中に打ち切る）。判定は `resolveCallResolution` に閉じている。
   */
  readonly dialExpiresAt?: string;
  /**
   * この通話を制御する Vonage REST の基底 URL（webhook の `region_url`。2026-09-02 仕様照合）。
   *
   * Vonage は通話ごとに所属リージョンを決める。切断（`PUT /v1/calls/{uuid}`）は
   * そのリージョンへ送るのが公式の案内で、グローバルの `api.nexmo.com` でも届くが経路が
   * 伸びる（切断の予算は 2 秒）。webhook を 1 件でも受けた時点で分かるので、そのとき残す。
   *
   * **任意**＝ `voiceState` と同じ後方互換の扱い。無ければグローバルへ撃つ。値は
   * `acceptRegionUrl`（`./vonage-webhook-body.ts`）を通った origin だけ（許可リスト済み）。
   */
  readonly regionUrl?: string;
  readonly status: CallCorrelationStatus;
  readonly updatedAt: string;
};

export interface CallCorrelationRepository {
  get(providerCallId: string): Promise<StoredCallCorrelation | undefined>;
  /** 期待テナントと一致するときだけ返す。越境と不在を**同じ結果**（undefined）にする。 */
  getForTenant(providerCallId: string, tenantId: string): Promise<StoredCallCorrelation | undefined>;
  put(correlation: StoredCallCorrelation): Promise<void>;
  /**
   * **読んだ時点から動いていないときだけ**部分更新する（atomic compare-and-set） (#646)。
   *
   * 🔴 **`put` では二重発信を塞げない。** Vonage は不応答の 1 通話に対し `unanswered` と
   * `completed` を**別 `jti`・ほぼ同時**に送る。Lambda では別インスタンスで並行実行され、
   * どちらも `status: 'in_flight'` を読んでから書くので、`jti` 台帳の duplicate 判定に
   * 掛からない。両方が dial 判断に至り、**担当者の電話が 2 本鳴る**。
   *
   * 使い道は 2 つあり、どちらも同じ危険を塞ぐ:
   *
   * 1. **次の手を撃つ権利**を 1 つの配信だけへ渡す（`next-hop-dial.ts`）
   * 2. webhook 1 件の適用結果の**保存**（`voice-event.ts`）。無条件 `put` だと、
   *    `/choice`（担当者の承諾）と `/events`（通話終了）が並行したときに、後から書いた側が
   *    先に書かれた確定を全体置換で潰す ── 承諾したのに次の担当者が鳴る、が復活する。
   *
   * `expectedUpdatedAt` に読んだ時点の値を渡し、`status` が `'in_flight'` のままで
   * `updatedAt` も動いていないときだけ更新する（楽観ロック）。負けた側は `false` を受け、
   * **撃たず・保存もしない**。
   */
  updateIfUnchanged(
    providerCallId: string,
    changes: Partial<StoredCallCorrelation>,
    expectedUpdatedAt: string,
  ): Promise<boolean>;
}

export class DataBackedCallCorrelationRepository implements CallCorrelationRepository {
  private readonly col: () => Collection<StoredCallCorrelation & { id: string }>;

  constructor() {
    this.col = () =>
      getBackend().collection<StoredCallCorrelation & { id: string }>(CALL_CORRELATION_COLLECTION, {
        ttlSeconds: CALL_CORRELATION_TTL_SECONDS,
      });
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

  async updateIfUnchanged(
    providerCallId: string,
    changes: Partial<StoredCallCorrelation>,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    return this.col().updateIf(providerCallId, changes, {
      status: 'in_flight',
      updatedAt: expectedUpdatedAt,
    });
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
