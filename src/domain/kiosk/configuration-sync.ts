/**
 * 端末側の構成同期（再取得と適用タイミング）の判定 (issue #420)。
 *
 * 端末は構成を**起動時 1 回**しか取っていなかったため、管理画面で公開した版は端末を再読込する
 * まで届かなかった（反映状況では正しく `stale` として出るが、届かないこと自体は
 * ライフサイクル「公開 → キオスク取得 → 反映 ACK」の欠落）。
 *
 * ここで決めるのは **いつ適用するか** だけ:
 *
 *   - **取得はいつしてもよい**（ポーリング）。取得は画面に影響しない。
 *   - **適用は受付が終わってから**。受付進行中に構成を差し替えると、来訪者の画面が操作の
 *     途中で入れ替わる（AC「受付中の来訪者が公開操作によって中断されない」に反する）。
 *   - ただし**まだ何も読み込んでいない端末は受付中でも適用する**。既定値（担当者ゼロ・既定
 *     文言）のまま接客させないため。`nextApplicableRevision`
 *     （`domain/experience-version/deployment.ts`）の「維持すべき版が無い端末は desired を
 *     採用する」と同じ規則。
 */

/** 構成の再取得間隔（ms）。営業状態ポーリング（`operating-status-poll.ts`）と揃える。 */
export const CONFIGURATION_SYNC_INTERVAL_MS = 60_000;

/** `?configSyncMs=` で指定できる下限。これ未満はサーバを叩き続けるだけなので丸める。 */
const MIN_SYNC_INTERVAL_MS = 100;

/** 構成の同定情報。版管理未導入の拠点は revision 0・指紋なしで届く。 */
export type ConfigurationIdentity = {
  revision?: number;
  contentHash?: string;
};

/**
 * 取得した構成を**いま**適用してよいか。
 *
 * @param input.current  いま適用している構成（未適用なら undefined）。
 * @param input.incoming 取得した構成。
 * @param input.sessionActive 受付が進行中か（待機画面以外に居るか）。
 */
export function shouldApplyConfiguration(input: {
  sessionActive: boolean;
  current?: ConfigurationIdentity;
  incoming?: ConfigurationIdentity;
}): boolean {
  if (!input.incoming) return false;
  // 未適用の端末は受付中でも適用する（既定値のまま接客させない）。
  if (!input.current) return true;

  // 内容が同じなら何もしない（無用な再描画を避ける）。指紋を持たない live 配信は
  // 「同じ revision でも中身が変わりうる」ため、常に変化したものとして扱う。
  const bothHashed = Boolean(input.current.contentHash) && Boolean(input.incoming.contentHash);
  if (
    bothHashed &&
    input.current.revision === input.incoming.revision &&
    input.current.contentHash === input.incoming.contentHash
  ) {
    return false;
  }

  // 受付進行中は現在の構成を固定し、次のセッションから新しい版を使う。
  return !input.sessionActive;
}

/**
 * 再取得間隔を決める。`?configSyncMs=` での短縮は E2E 用（既存の `?inactivityMs=` /
 * `?callingStageMs=` と同じ流儀）。不正値は既定へ倒し、下限で丸める。
 */
export function resolveConfigurationSyncInterval(search: string): number {
  const raw = new URLSearchParams(search).get('configSyncMs');
  if (raw === null) return CONFIGURATION_SYNC_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return CONFIGURATION_SYNC_INTERVAL_MS;
  return Math.max(MIN_SYNC_INTERVAL_MS, value);
}
