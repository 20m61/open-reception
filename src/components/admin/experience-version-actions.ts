import type { ReceptionExperienceVersion } from '@/domain/experience-version/types';
import { hasValidationErrors } from '@/domain/experience-version/deployment-view';

/**
 * 受付体験の版管理で「いまどの操作が押せるか」を決める純関数 (issue #554)。
 *
 * ## なぜ関数に切り出すか
 *
 * この repo で**繰り返し P1 になっている欠陥**は「ハンドラを止めたのにボタンの `disabled` へ
 * 写していない（＝押せるのに何も起きないサイレント no-op）」。規律では抜けるので、
 * **ハンドラとボタンが同じ 1 つの値を見る**形にして、分岐しようがなくする。
 *
 * ## `save-draft` だけ版の取得状態に依存させない
 *
 * 「現在の設定を下書きにする」は**いまの設定ストアの内容**を固定する操作で、版一覧を参照
 * しない（API も `revision` を要求しない）。ここに `versionsLoaded` を混ぜると、
 * **一覧 GET が 1 回失敗しただけで復旧経路が永久に止まる** — PR #552 で実際に P1 になった
 * 「読み取りの失敗が書き込みを殺す」形。
 *
 * 逆に承認・公開・切り戻しは **`revision` を版一覧から取る**ので、表示中の版が現在の拠点の
 * ものだと確認できるまで通してはいけない。`revision` は experience ごとの連番で拠点間で
 * 衝突するため、前拠点の rev.5 を掴んだまま新拠点へ投げると**別拠点の rev.5 を公開/巻き戻す**。
 */

export type VersionActionInput = {
  /** 対象拠点が確定しているか（`useSiteScope.scopeReady`）。 */
  scopeReady: boolean;
  /** 拠点切替の遷移が確定していないか（`useSiteScope.sitePending`）。 */
  sitePending: boolean;
  /** 送信中。 */
  busy: boolean;
  /** 表示中の版一覧が現在のスコープのものか。 */
  versionsLoaded: boolean;
  draft?: ReceptionExperienceVersion;
  published?: ReceptionExperienceVersion;
  rollbackTarget?: ReceptionExperienceVersion;
};

export type VersionAction = 'save-draft' | 'approve' | 'publish' | 'rollback';

export type VersionActionAvailability = Record<VersionAction, boolean>;

export function resolveVersionActions(input: VersionActionInput): VersionActionAvailability {
  // 拠点が確定し、切替が確定し、送信中でない。ここまでは全操作の前提。
  const base = input.scopeReady && !input.sitePending && !input.busy;
  // 版を名指しする操作の追加条件（上の解説）。
  const onVersion = base && input.versionsLoaded;

  return {
    'save-draft': base,
    approve:
      onVersion &&
      input.draft !== undefined &&
      input.draft.approvedBy === undefined &&
      !hasValidationErrors(input.draft),
    publish: onVersion && input.draft !== undefined && input.draft.approvedBy !== undefined,
    rollback: onVersion && input.rollbackTarget !== undefined && input.published !== undefined,
  };
}
