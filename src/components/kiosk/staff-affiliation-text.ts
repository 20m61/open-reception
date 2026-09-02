import type { MessageKey } from '@/lib/i18n/dictionary';
import type { DirDepartment, DirStaff } from './useEffectiveConfiguration';

/**
 * 担当者候補カードに出す所属テキスト (#373)。
 *
 * ## なぜ関数に切り出すか
 *
 * ここは `s.affiliationLabel ?? 部署名` という 1 行だったが、**その 1 行が欠陥の本体**だった。
 * 「空文字」と「キーが無い」の区別を誤ると、運用者が非公開にした所属が部署名として出戻る。
 * JSX に埋めたままでは自動検証が効かないので、規則として取り出して固定する。
 *
 * ## 規則
 *
 * - `affiliationLabel` が **string なら常にそれを使う**（空文字を含む）。空文字は
 *   「組織モデル側が『来訪者へ出せる所属は無い』と判断した」という**結論**であって、
 *   情報の欠落ではない。部署名で埋め戻してはいけない。
 * - `affiliationLabel` が **無い**ときだけ部署名へフォールバックする。これは旧経路
 *   （`/api/configuration/effective` 失敗時の `/api/kiosk/directory`）が組織モデルを
 *   読まずラベルを持たないため。
 *
 * `??` ではなく presence で判定するのは、版スナップショットや別のプロデューサ由来の
 * 値が素通しで届く経路があるため（`selectDirectory` は検証なしのキャストだった）。
 *
 * ## 整形はここでやる
 *
 * サーバは構造（主所属・兼務の名前）だけを返す。`（兼: …）` / `(also …)` の整形は locale
 * 依存で、サーバは端末の locale を持たない。しかも構成は版スナップショットへ焼き込まれるので、
 * サーバ側で文字列にすると日本語が固定される。
 */
export function staffAffiliationText(
  staff: Pick<DirStaff, 'departmentId' | 'affiliation'>,
  departments: ReadonlyArray<DirDepartment>,
  tr: (key: MessageKey, params?: Record<string, string>) => string,
): string {
  const affiliation = staff.affiliation;
  if (affiliation === undefined) {
    // 旧経路（縮退時の `/api/kiosk/directory`）はここへ来る。所属を全部消さない。
    return departments.find((d) => d.id === staff.departmentId)?.name ?? '';
  }
  // 主所属が非公開でも兼務が公開なら、兼務の先頭を出す（何も出さないよりは識別できる）。
  const primary = affiliation.primary ?? affiliation.secondary[0];
  if (primary === undefined) return '';
  const others = affiliation.primary === undefined ? [] : affiliation.secondary;
  if (others.length === 0) return primary;
  return tr('reception.affiliationWithSecondary', {
    primary,
    secondary: others.join(tr('reception.affiliationSeparator')),
  });
}
