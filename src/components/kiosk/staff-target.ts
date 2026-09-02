import type { MessageKey } from '@/lib/i18n/dictionary';
import { staffAffiliationText } from './staff-affiliation-text';
import type { DirDepartment, DirStaff } from './useEffectiveConfiguration';
import type { ReceptionTarget } from './voice-target-binding';

/**
 * 担当者候補から `SELECT_TARGET` の相手を作る (#591)。
 *
 * ## なぜ関数にするか
 *
 * 候補一覧で同姓同名を区別できても、**発信直前の確認画面**で区別できなければ意味がない。
 * 来訪者は後戻りできない画面で「自分がどちらを選んだか」を確認する。ここが表示名だけだと、
 * 誤った相手を呼び出しても気づけない ＝ 受付完遂の失敗が失敗として見えない。
 *
 * 所属は `sublabel` に入れる。`label` は読み上げと監査に流れるので混ぜない。
 * 一覧と確認画面で**同じ文字列**が出ることが要点なので、導出を 1 箇所に持つ。
 */
export function staffTargetFor(
  staff: Pick<DirStaff, 'id' | 'displayName' | 'departmentId' | 'affiliation'>,
  departments: ReadonlyArray<DirDepartment>,
  tr: (key: MessageKey, params?: Record<string, string>) => string,
): ReceptionTarget {
  const sublabel = staffAffiliationText(staff, departments, tr);
  return {
    type: 'staff',
    id: staff.id,
    label: staff.displayName,
    // 出せる所属が無ければキーごと落とす（確認画面に空行を作らない）。
    ...(sublabel === '' ? {} : { sublabel }),
  };
}
