import { assessStaffKana, kanaIssueMessage } from '@/domain/staff/kana';
import type { KanaFieldState } from './StaffKana';

/**
 * 担当者の追加フォームの送信可否と、保存結果の文言 (#1287)。
 *
 * `StaffManager` は送信の相互作用を unit で描けないので、判定と文言をここへ純関数で出し、
 * 配線は `staff-form.test.ts` が構造で縛る。
 */

/**
 * 追加フォームを送信してよいか。追加の処理（`add`）とボタンの `disabled` の両方がこれを使う。
 * 読みは方針（`STAFF_KANA_POLICY`）の下の `kanaField.blocksSubmit` に従う（`required` で `ok` 以外は止める）。
 */
export function canSubmitStaff(input: {
  busy: boolean;
  displayName: string;
  departmentId: string;
  /** 部署が読めているか。読めていないと部署を選べない（#966）。 */
  departmentsLoaded: boolean;
  kanaField: Pick<KanaFieldState, 'blocksSubmit'>;
}): boolean {
  return (
    !input.busy &&
    input.displayName.trim() !== '' &&
    input.departmentId !== '' &&
    input.departmentsLoaded &&
    !input.kanaField.blocksSubmit
  );
}

/**
 * サーバが入力を拒否した（400）ときの理由。管理 API は `{ error, message }` を返し、読みの拒否では
 * `message` が日本語の案内文になる。それ以外（届かない・400 以外・本文が読めない）は `null`。
 */
export async function rejectionReason(res: Response | null): Promise<string | null> {
  if (res === null || res.status !== 400) return null;
  try {
    const body = (await res.json()) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    return message === '' ? null : message;
  } catch {
    return null;
  }
}

/** 汎用の失敗文に、分かっていればサーバの理由を続ける。 */
export function withReason(base: string, reason: string | null): string {
  return reason === null ? base : `${base}${reason}`;
}

/**
 * 保存の直後に、読みが正しくなければ警告を添える。案 B（encouraged）では正しくない読みも保存できるので、
 * 追加と「よみがなを直す」の両方で同じ文を出す（#1287 m3）。
 */
export function savedWithKanaWarning(base: string, kana: string | undefined): string {
  const warning = kanaIssueMessage(assessStaffKana(kana));
  return warning === null ? base : `${base}${warning}`;
}
