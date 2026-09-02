/**
 * 端末への構成反映の状態判定 (issue #420)。
 *
 * 管理画面が「公開したのに、どの端末に届いていないか」を答えられるようにするための純関数。
 * 端末は heartbeat で `loadedRevision` / `loadedConfigHash` / 読込エラーを報告し、
 * サーバは公開中の版（desired）と突き合わせて分類する。
 *
 * 版番号だけでなく指紋も突き合わせるのは、同じ revision を名乗りながら中身が違う端末
 * （キャッシュ残り・部分反映）を「反映済み」と誤認しないため。
 */
import type { DeploymentStatus, KioskConfigDeployment } from './types';

/**
 * 1 端末の反映状態。
 *   - `failed`  … desired の読込で失敗が報告されている（last-known-good で運用継続中）。
 *   - `applied` … 版・指紋ともに desired と一致。
 *   - `pending` … まだ何も読み込んでいない（新規端末・未起動）。
 *   - `stale`   … 別の版/内容で動いている。desired より新しい版を名乗る場合も含む（不整合）。
 */
export function classifyDeployment(deployment: KioskConfigDeployment): DeploymentStatus {
  const { desiredRevision, desiredConfigHash, loadedRevision, loadedConfigHash } = deployment;

  if (deployment.errorCode && deployment.errorRevision === desiredRevision) return 'failed';
  if (loadedRevision === undefined) return 'pending';
  if (loadedRevision === desiredRevision && loadedConfigHash === desiredConfigHash) {
    return 'applied';
  }
  return 'stale';
}

/** 公開中の版より古い（または未読込の）端末か。 */
export function isStale(input: {
  publishedRevision: number;
  loadedRevision: number | undefined;
}): boolean {
  return input.loadedRevision === undefined || input.loadedRevision < input.publishedRevision;
}

export type RolloutSummary = {
  total: number;
  applied: number;
  pending: number;
  stale: number;
  failed: number;
  /** 全端末が applied のときだけ true。対象 0 台は false（公開できたと誤認させない）。 */
  complete: boolean;
};

export function summarizeRollout(deployments: readonly KioskConfigDeployment[]): RolloutSummary {
  const summary: RolloutSummary = {
    total: deployments.length,
    applied: 0,
    pending: 0,
    stale: 0,
    failed: 0,
    complete: false,
  };
  for (const deployment of deployments) {
    summary[classifyDeployment(deployment)] += 1;
  }
  summary.complete = summary.total > 0 && summary.applied === summary.total;
  return summary;
}

/**
 * 端末が次に適用すべき版。**受付が進行中なら現在の版を維持する**
 * （AC「受付中の来訪者が公開操作によって中断されない」）。維持すべき版が無い端末
 * （未読込）は受付中でも desired を採用する。
 */
export function nextApplicableRevision(input: {
  loadedRevision: number | undefined;
  desiredRevision: number;
  sessionActive: boolean;
}): number {
  if (input.sessionActive && input.loadedRevision !== undefined) return input.loadedRevision;
  return input.desiredRevision;
}
