/**
 * 担当者ドメイン型 (issue #13, #26)。
 */

/** mock 呼び出しの結果分岐。MockCallAdapter のみが参照し、本番 adapter は無視する (issue #20)。 */
export type MockCallOutcome = 'success' | 'no_answer' | 'failure' | 'timeout';

export type Staff = {
  id: string;
  displayName: string;
  kana?: string;
  aliases: string[];
  departmentId: string;
  enabled: boolean;
  available: boolean;
  /** mock 環境での呼び出し結果。未設定時は success 扱い。 */
  mockCallOutcome?: MockCallOutcome;
};
