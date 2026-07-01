/**
 * プラットフォーム アップデート状況 (issue #83 §提供機能 / AC6)。
 *
 * 総合開発者が「どのテナント/拠点/端末が最新か、更新待ち/更新中/失敗はどれか」を横断把握する
 * ための状況モデルと、read 用集計・射影の純関数。I/O は持たない（永続化は
 * src/lib/platform/update-status-store）。
 *
 * セキュリティ/PII 方針（#83）: 横断 read 行に来訪者/担当者 PII を含めない。`updatedBy`（操作者
 * 識別子）は表示行に載せず、誰が更新したかは監査ログ側で追う。version 文字列は運用値であり PII を
 * 書かない運用とする。実際の更新実行（デプロイ/ロールバック）は破壊的操作のため後段増分
 * （JIT 昇格・理由入力・監査つき）で扱い、本モジュールは read のみを対象にする。
 */

/** 更新対象のスコープ。 */
export type UpdateScope = 'platform' | 'tenant' | 'site' | 'device';

/** 更新状況。`update_available`/`updating`/`failed` を「対応が要る（pending）」とみなす。 */
export type UpdateState = 'up_to_date' | 'update_available' | 'updating' | 'failed';

/** アップデート状況（#83 推奨データモデル）。 */
export type UpdateStatus = {
  id: string;
  scope: UpdateScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  /** 更新対象コンポーネント（例: kiosk-app / opennext / firmware）。 */
  component: string;
  /** 稼働中バージョン。 */
  currentVersion: string;
  /** 利用可能な最新バージョン。 */
  latestVersion: string;
  state: UpdateState;
  /** 最終確認日時（ISO）。 */
  checkedAt: string;
  /** 最終更新者（操作者識別子）。横断 read 行には載せない。 */
  updatedBy: string;
};

/** 横断 read 用の行。PII・操作者識別子を含めない。 */
export type UpdateStatusRow = {
  id: string;
  scope: UpdateScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  component: string;
  currentVersion: string;
  latestVersion: string;
  state: UpdateState;
  checkedAt: string;
  /** `up_to_date` 以外（対応が要る）か。 */
  pending: boolean;
};

/** アップデート状況の横断集計。 */
export type UpdateStatusSummary = {
  /** 対応が要る（up_to_date 以外）件数。 */
  pendingCount: number;
  /** 全件数。 */
  totalCount: number;
  /** 状況内訳（全件）。 */
  byState: Record<UpdateState, number>;
  /** 表示用に並べ替えた行（pending 優先 → 状況の重み降順 → 確認新しい順）。 */
  updates: UpdateStatusRow[];
};

/** 状況の重み（大きいほど注意）。並べ替えに使う。 */
const STATE_RANK: Record<UpdateState, number> = {
  up_to_date: 0,
  updating: 1,
  update_available: 2,
  failed: 3,
};

/** 対応が要る（up_to_date 以外）か。 */
export function isPendingUpdate(update: Pick<UpdateStatus, 'state'>): boolean {
  return update.state !== 'up_to_date';
}

/** アップデート状況を横断 read 行へ射影する純関数（whitelist。updatedBy は載せない）。 */
export function toUpdateStatusRow(update: UpdateStatus): UpdateStatusRow {
  return {
    id: update.id,
    scope: update.scope,
    tenantId: update.tenantId,
    siteId: update.siteId,
    deviceId: update.deviceId,
    component: update.component,
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    state: update.state,
    checkedAt: update.checkedAt,
    pending: isPendingUpdate(update),
  };
}

/**
 * アップデート状況一覧を横断集計する純関数。
 * 並び順: 対応が要るものを先頭 → 状況の重み降順（failed→update_available→updating）→ 確認新しい順。
 */
export function summarizeUpdateStatuses(updates: readonly UpdateStatus[]): UpdateStatusSummary {
  const rows = updates.map(toUpdateStatusRow).sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    if (a.state !== b.state) return STATE_RANK[b.state] - STATE_RANK[a.state];
    return b.checkedAt.localeCompare(a.checkedAt);
  });

  const byState: Record<UpdateState, number> = {
    up_to_date: 0,
    update_available: 0,
    updating: 0,
    failed: 0,
  };
  for (const row of rows) byState[row.state] += 1;

  return {
    // up_to_date 以外＝pending。byState 集計から導出（追加の走査を避ける）。
    pendingCount: rows.length - byState.up_to_date,
    totalCount: rows.length,
    byState,
    updates: rows,
  };
}
