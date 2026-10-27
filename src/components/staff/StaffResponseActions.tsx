'use client';

/**
 * 担当者の応答アクション選択 UI (issue #99 increment 1)。
 *
 * 既存の StaffCallView（通話参加）に併設して使う。担当者は「今行きます / 5分お待ちください /
 * 別担当に回します / 本日は対応できません / 受付電話へ」から選び、結果は受付端末へ反映される
 * （/api/staff/calls/:id/respond）。
 *
 * 誤タップ防止: requiresConfirmation な種別（拒否・別チャネル誘導）は 2 段階で確認する。
 * 通話参加導線は壊さない（本コンポーネントは応答アクションのみを扱う）。
 */
import { useCallback, useState } from 'react';
import {
  type StaffResponseAction,
  type StaffResponseResult,
} from '@/domain/reception/staff-response';
import type { ActionMeta } from './use-staff-response-actions';
import {
  staffFailureForStatus,
  staffResponseFailureMessage,
  type StaffFailure,
} from './staff-failure';

/**
 * 🔴 **error は必ず原因を伴う (#1123)。** 原因を別 state に分けて既定値で補うと、
 * **その既定が嘘側（「リンクの有効期限切れ」）に倒れる**。表現不能にしておく。
 */
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'error'; failure: StaffFailure };

export type StaffResponseActionsProps = {
  receptionId: string;
  token: string;
  /**
   * この受付で選べる応答種別。
   *
   * 🔴 **取得は親（`StaffCallView`）が持つ (#1137)。** 以前はここで fetch していたが、
   * そうすると**失敗文言を作る側から「ボタンが 0 個か」が見えない** ——
   * 「下の応答からの返答も試せます」が空の領域を指す形になっていた。
   */
  actions: ReadonlyArray<ActionMeta>;
};

export function StaffResponseActions({
  receptionId,
  token,
  actions,
}: StaffResponseActionsProps): React.ReactElement {
  // 確認待ちの種別（誤タップ防止）。null なら確認中なし。
  const [pendingConfirm, setPendingConfirm] = useState<StaffResponseAction | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });
  const [lastResult, setLastResult] = useState<StaffResponseResult | null>(null);
  const submit = useCallback(
    async (action: StaffResponseAction) => {
      setSubmitState({ kind: 'submitting' });
      setPendingConfirm(null);
      try {
        const res = await fetch(`/api/staff/calls/${receptionId}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, action }),
        });
        if (!res.ok) {
          // 🔴 状態コードを見る。非 ok を一括で「リンク切れ」にしない (#1123)。
          setSubmitState({ kind: 'error', failure: staffFailureForStatus(res.status) });
          return;
        }
        setLastResult((await res.json()) as StaffResponseResult);
        setSubmitState({ kind: 'done' });
      } catch {
        // 応答が返らなかった。**届いたか分かっていない**ので、リンクのせいにしない。
        setSubmitState({ kind: 'error', failure: 'unreachable' });
      }
    },
    [receptionId, token],
  );

  const onClick = useCallback(
    (action: StaffResponseAction, requiresConfirmation: boolean) => {
      if (requiresConfirmation && pendingConfirm !== action) {
        setPendingConfirm(action);
        return;
      }
      void submit(action);
    },
    [pendingConfirm, submit],
  );

  const definitions = actions.filter((d) => d.enabled);
  // 🔴 **見出しだけの空領域を出さない (#1137 AC3)。** サイト設定で応答種別を全部
  //    無効化していると、以前は「来訪者への応答を選んでください」とボタン 0 個の
  //    `section` が残った —— 担当者は**選べないものを探す**。選べないなら、
  //    見出しも「選んでください」ではなく、**そう言う**。
  //
  // 🔴 **「今どうするか」を先に言う（レビュー 1 周目 MAJOR 2 / J-OR-05）。**
  //    5 種別が全部無効＝**来訪者の状態を動かす手段が 1 つも無い**ということなので、
  //    「管理者へ知らせる」は設定を直す行為であって、**目の前で待っている来訪者を
  //    救う行為ではない**。ただし**サイトの運用を前提にした指示は書かない**
  //    （「受付窓口へ」は窓口が無いサイトで嘘になる。ユーザー判断で事実だけに留めた）。
  const empty = definitions.length === 0;

  return (
    <section
      className="staff-response"
      data-testid="staff-response"
      data-submit-state={submitState.kind}
    >
      <h2 className="staff-response__title">
        {empty ? '来訪者への応答は設定されていません' : '来訪者への応答を選んでください'}
      </h2>
      {empty ? (
        <p className="staff-response__status notice" role="status" data-testid="staff-response-empty">
          この受付では応答種別がすべて無効になっています。
          <strong>この画面から来訪者へ返答する導線はありません。直接の対応が必要です。</strong>
          設定については管理者へ知らせてください。
        </p>
      ) : null}
      <div className="staff-response__actions">
        {definitions.map((def) => {
          const awaitingConfirm = pendingConfirm === def.action;
          return (
            <div key={def.action} className="staff-response__item">
              <button
                type="button"
                className={`btn ${def.severity === 'danger' ? 'btn--danger' : 'btn--secondary'}`}
                data-testid={`staff-response-${def.action}`}
                data-confirming={awaitingConfirm ? 'true' : undefined}
                disabled={submitState.kind === 'submitting'}
                aria-busy={submitState.kind === 'submitting'}
                onClick={() => onClick(def.action, def.requiresConfirmation)}
              >
                {awaitingConfirm ? `本当に「${def.staffLabel}」でよろしいですか？（もう一度）` : def.staffLabel}
              </button>
              {awaitingConfirm ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  data-testid={`staff-response-${def.action}-cancel`}
                  onClick={() => setPendingConfirm(null)}
                >
                  キャンセル
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {submitState.kind === 'done' && lastResult ? (
        <p className="staff-response__status" role="status" data-testid="staff-response-done">
          応答しました（来訪者には「{lastResult.visitorMessage}」と表示されます）。
        </p>
      ) : null}
      {submitState.kind === 'error' ? (
        <p className="staff-response__status notice notice--danger" role="status" data-testid="staff-response-error">
          {staffResponseFailureMessage(submitState.failure)}
        </p>
      ) : null}
    </section>
  );
}
