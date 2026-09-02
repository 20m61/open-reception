import type { OrganizationUnit } from './types';

/**
 * 組織が来訪者に見えるか。見えないなら**なぜか** (#373 増分 6)。
 *
 * ## なぜ理由まで返すか
 *
 * 運用者にとって最も分かりにくい失敗は「保存したのに来訪者画面に出ない」。無効なのか、
 * 非公開なのか、公開表示名が空なのかで直し方が違う。画面が「出ない」としか言わなければ
 * 原因に辿り着けず、設定を触り回すことになる。
 *
 * ## 読み側と同じ判定であること
 *
 * `publicUnitsInScope`（来訪者向け一覧の絞り込み）はこの関数を使う。別々に書くと、
 * **管理画面が「見える」と言っているのに来訪者には出ない**という最悪の食い違いになる。
 */
export type OrganizationVisibility =
  | { kind: 'visible' }
  | { kind: 'hidden'; reason: 'disabled' | 'not-public' | 'no-public-name' };

export function organizationVisibility(unit: OrganizationUnit): OrganizationVisibility {
  // 順序は**運用者が最初に直すべきもの**から。無効な組織の表示名を直させても出ない。
  if (!unit.enabled) return { kind: 'hidden', reason: 'disabled' };
  if (!unit.publicInDirectory) return { kind: 'hidden', reason: 'not-public' };
  if (unit.publicDisplayName.trim() === '') return { kind: 'hidden', reason: 'no-public-name' };
  return { kind: 'visible' };
}

/** 来訪者へ出してよいか（`organizationVisibility` の真偽版）。 */
export function isVisibleToVisitor(unit: OrganizationUnit): boolean {
  return organizationVisibility(unit).kind === 'visible';
}
