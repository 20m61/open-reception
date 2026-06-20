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
  listStaffResponseDefinitions,
  type StaffResponseAction,
  type StaffResponseResult,
} from '@/domain/reception/staff-response';

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

export type StaffResponseActionsProps = {
  receptionId: string;
  token: string;
};

export function StaffResponseActions({ receptionId, token }: StaffResponseActionsProps): React.ReactElement {
  // 確認待ちの種別（誤タップ防止）。null なら確認中なし。
  const [pendingConfirm, setPendingConfirm] = useState<StaffResponseAction | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [lastResult, setLastResult] = useState<StaffResponseResult | null>(null);

  const submit = useCallback(
    async (action: StaffResponseAction) => {
      setSubmitState('submitting');
      setPendingConfirm(null);
      try {
        const res = await fetch(`/api/staff/calls/${receptionId}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, action }),
        });
        if (!res.ok) {
          setSubmitState('error');
          return;
        }
        setLastResult((await res.json()) as StaffResponseResult);
        setSubmitState('done');
      } catch {
        setSubmitState('error');
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

  const definitions = listStaffResponseDefinitions().filter((d) => d.defaultEnabled);

  return (
    <section className="staff-response" data-testid="staff-response" data-submit-state={submitState}>
      <h2 className="staff-response__title">来訪者への応答を選んでください</h2>
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
                disabled={submitState === 'submitting'}
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
      {submitState === 'done' && lastResult ? (
        <p className="staff-response__status" role="status" data-testid="staff-response-done">
          応答しました（来訪者には「{lastResult.visitorMessage}」と表示されます）。
        </p>
      ) : null}
      {submitState === 'error' ? (
        <p className="staff-response__status notice notice--danger" role="status" data-testid="staff-response-error">
          応答を送れませんでした。リンクの有効期限切れ、または受付が終了している可能性があります。
        </p>
      ) : null}
    </section>
  );
}
