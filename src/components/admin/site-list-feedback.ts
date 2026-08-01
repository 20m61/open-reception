import type { SiteListStatus } from './site-context';

/**
 * 拠点一覧そのものを出す画面（`/admin/sites`）が、取得状態をどう伝えるかを決める純関数
 * (#554 M3)。
 *
 * **「取得できていない」を「0 件」として出さない。** `SitesManager` は `useSiteList` の
 * `status` を捨てていたため、401/403/5xx・オフラインのどれでも
 * 「このテナントに登録された拠点はありません。」と断定していた。運用者からは
 * **拠点が消えたように見える**（しかもヘッダは「確認できません」と出すので、同じ画面の
 * 2 箇所が違うことを言う）。#536 で `SiteDetail` に対して直したのと同じ問題が、
 * 別の画面に残っていた形。
 *
 * 判定を component 内の三項演算子に散らすと写し忘れるので、1 つの値から全部を導く。
 */
export type SiteListFeedback = {
  /** 表が空のときの文言。 */
  emptyMessage: string;
  /** 取得し直す導線を出すか。 */
  showRetry: boolean;
  /** 件数（「N 件中 M 件」）を出してよいか。取得できていない一覧の件数は意味を持たない。 */
  showCount: boolean;
};

export function resolveSiteListFeedback(
  status: SiteListStatus,
  /** 検索・絞り込みが掛かっているか（空の理由が「条件に一致しない」になる）。 */
  hasFilter: boolean,
): SiteListFeedback {
  switch (status) {
    case 'error':
      return {
        emptyMessage: '拠点一覧を取得できませんでした。',
        showRetry: true,
        showCount: false,
      };
    // `idle`（取りに行っていない）も確定していない点は `loading` と同じ。
    // 断定しない側へ倒す。
    case 'idle':
    case 'loading':
      return { emptyMessage: '読み込み中…', showRetry: false, showCount: false };
    case 'ready':
      return {
        emptyMessage: hasFilter
          ? '条件に一致する拠点はありません。'
          : 'このテナントに登録された拠点はありません。',
        showRetry: false,
        showCount: true,
      };
  }
}
