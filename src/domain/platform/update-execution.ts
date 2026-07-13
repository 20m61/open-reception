/**
 * アップデート実行/ロールバックの純ロジック (#290 item1)。
 *
 * 総合開発者による更新実行（デプロイ）/ロールバックの「実行可否の検証」と「デプロイ結果からの
 * 状態遷移」を純関数で固める。I/O は持たない（レジストリ読取・永続化・監査は route/lib、実デプロイは
 * `@/lib/platform/update-deployer` の UpdateDeployer 実装）。
 *
 * 実デプロイ本体は外部リソース待ち（#195 / #65）のため interface+mock 先行で設計する。本モジュールは
 * デプロイ手段に依存せず、プラン算出と結果反映のみを担う（mock でも実 deployer でも同じ遷移になる）。
 */
import type { UpdateStatus, UpdateState } from './update-status';

/** 実行アクション。 */
export type UpdateAction = 'apply' | 'rollback';

/** 実行プラン（dry-run で提示し、実行時はこの toVersion をデプロイ対象にする）。 */
export type UpdateExecutionPlan = {
  id: string;
  action: UpdateAction;
  component: string;
  /** 実行前バージョン（currentVersion）。 */
  fromVersion: string;
  /** 実行後に狙うバージョン（apply=latest / rollback=指定）。 */
  toVersion: string;
};

/** デプロイ結果（実 deployer / mock 共通）。 */
export type DeployOutcome = { ok: boolean };

/**
 * アクションが現在の状態で実行可能か検証し、実行プランを算出する純関数。updating 中は不可。
 * apply は up_to_date 以外かつ latest≠current のみ。rollback は toVersion 必須で現行と異なること。
 */
export function planUpdateExecution(
  status: UpdateStatus,
  action: UpdateAction,
  input: { toVersion?: string } = {},
): { ok: true; plan: UpdateExecutionPlan } | { ok: false; error: string } {
  if (status.state === 'updating') {
    return { ok: false, error: 'update already in progress' };
  }
  const base = { id: status.id, action, component: status.component, fromVersion: status.currentVersion };

  if (action === 'apply') {
    if (status.state === 'up_to_date') return { ok: false, error: 'already up to date' };
    if (status.latestVersion === status.currentVersion) {
      return { ok: false, error: 'no newer version available' };
    }
    return { ok: true, plan: { ...base, toVersion: status.latestVersion } };
  }

  // rollback: 戻し先バージョンは操作者が明示する（バージョン履歴は持たないため）。
  const toVersion = (input.toVersion ?? '').trim();
  if (toVersion === '') return { ok: false, error: 'toVersion is required for rollback' };
  if (toVersion === status.currentVersion) return { ok: false, error: 'toVersion equals current version' };
  return { ok: true, plan: { ...base, toVersion } };
}

/**
 * デプロイ結果から次の UpdateStatus を導く純関数。成功で currentVersion=toVersion に更新し、
 * latest と一致すれば up_to_date、未満なら update_available（rollback 後など）。失敗は failed で
 * version を据え置く。checkedAt/updatedBy を更新する。
 */
export function resultingUpdateStatus(
  status: UpdateStatus,
  plan: UpdateExecutionPlan,
  outcome: DeployOutcome,
  opts: { now: Date; operator: string },
): UpdateStatus {
  const checkedAt = opts.now.toISOString();
  if (!outcome.ok) {
    return { ...status, state: 'failed', checkedAt, updatedBy: opts.operator };
  }
  const currentVersion = plan.toVersion;
  const state: UpdateState = currentVersion === status.latestVersion ? 'up_to_date' : 'update_available';
  return { ...status, currentVersion, state, checkedAt, updatedBy: opts.operator };
}
