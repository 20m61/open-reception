'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  RECEPTION_PURPOSES,
  type ReceptionPurposeId,
  type ReceptionTargetType,
  type VisitorInfo,
} from '@/domain/reception/session';
import { transition, type ReceptionEvent, type ReceptionState } from '@/domain/reception/state';
import { MOCK_DEPARTMENTS, MOCK_STAFF } from '@/domain/staff/mock-data';
import { searchStaff } from '@/domain/staff/search';

/** MVP では端末 ID は固定。将来 kiosk config から取得する (issue #18)。 */
const KIOSK_ID = 'kiosk-dev';
/** 完了・キャンセル後に待機画面へ自動復帰するまでの時間。 */
const AUTO_RESET_MS = 6000;

type Target = { type: ReceptionTargetType; id: string; label: string };
type CallOutcome = 'connected' | 'timeout' | 'failed';

type FlowData = {
  state: ReceptionState;
  purpose?: ReceptionPurposeId;
  target?: Target;
  visitor?: VisitorInfo;
  sessionId?: string;
  outcome?: CallOutcome;
};

type Action =
  | { type: 'START' }
  | { type: 'SELECT_PURPOSE'; purpose: ReceptionPurposeId }
  | { type: 'SELECT_TARGET'; target: Target }
  | { type: 'SUBMIT_VISITOR_INFO'; visitor: VisitorInfo }
  | { type: 'CONFIRM' }
  | { type: 'CALL_CONNECTED'; sessionId: string }
  | { type: 'CALL_TIMEOUT'; sessionId: string }
  | { type: 'CALL_FAILED'; sessionId?: string }
  | { type: 'USE_FALLBACK' }
  | { type: 'COMPLETE' }
  | { type: 'BACK' }
  | { type: 'RESET' };

const INITIAL: FlowData = { state: 'idle' };

function reducer(data: FlowData, action: Action): FlowData {
  const next = transition(data.state, action.type as ReceptionEvent);
  // 不正遷移は無視して現状維持（受付画面を壊さない）。
  if (next === null) return data;

  switch (action.type) {
    case 'SELECT_PURPOSE':
      return { ...data, state: next, purpose: action.purpose, target: undefined };
    case 'SELECT_TARGET':
      return { ...data, state: next, target: action.target };
    case 'SUBMIT_VISITOR_INFO':
      return { ...data, state: next, visitor: action.visitor };
    case 'CALL_CONNECTED':
      return { ...data, state: next, sessionId: action.sessionId, outcome: 'connected' };
    case 'CALL_TIMEOUT':
      return { ...data, state: next, sessionId: action.sessionId, outcome: 'timeout' };
    case 'CALL_FAILED':
      return { ...data, state: next, sessionId: action.sessionId, outcome: 'failed' };
    case 'RESET':
      return INITIAL;
    default:
      return { ...data, state: next };
  }
}

export function KioskFlow() {
  const [data, dispatch] = useReducer(reducer, INITIAL);

  // 呼び出し中になったら、セッション作成 → 呼び出しを実行して結果を反映する。
  useEffect(() => {
    if (data.state !== 'calling') return;
    let cancelled = false;

    (async () => {
      try {
        const createRes = await fetch('/api/kiosk/receptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kioskId: KIOSK_ID,
            purpose: data.purpose,
            targetType: data.target?.type,
            targetId: data.target?.id,
            targetLabel: data.target?.label,
            visitor: data.visitor,
          }),
        });
        if (!createRes.ok) {
          if (!cancelled) dispatch({ type: 'CALL_FAILED' });
          return;
        }
        const session = (await createRes.json()) as { id: string };
        const callRes = await fetch(`/api/kiosk/receptions/${session.id}/call`, { method: 'POST' });
        const result = (await callRes.json()) as { state: ReceptionState };
        if (cancelled) return;
        if (result.state === 'connected') dispatch({ type: 'CALL_CONNECTED', sessionId: session.id });
        else if (result.state === 'timeout') dispatch({ type: 'CALL_TIMEOUT', sessionId: session.id });
        else dispatch({ type: 'CALL_FAILED', sessionId: session.id });
      } catch {
        if (!cancelled) dispatch({ type: 'CALL_FAILED' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data.state, data.purpose, data.target, data.visitor]);

  // 完了・キャンセル後は一定時間で待機画面へ自動復帰する。個人情報も破棄される。
  useEffect(() => {
    if (data.state !== 'completed' && data.state !== 'cancelled') return;
    const timer = setTimeout(() => dispatch({ type: 'RESET' }), AUTO_RESET_MS);
    return () => clearTimeout(timer);
  }, [data.state]);

  const complete = useCallback(async () => {
    if (data.sessionId) {
      try {
        await fetch(`/api/kiosk/receptions/${data.sessionId}/complete`, { method: 'POST' });
      } catch {
        /* 完了通知の失敗は受付フローを止めない */
      }
    }
    dispatch({ type: 'COMPLETE' });
  }, [data.sessionId]);

  return (
    <main className="screen" data-kiosk-state={data.state}>
      {renderScreen(data, dispatch, complete)}
    </main>
  );
}

function renderScreen(
  data: FlowData,
  dispatch: React.Dispatch<Action>,
  complete: () => void,
) {
  switch (data.state) {
    case 'idle':
      return <IdleView onStart={() => dispatch({ type: 'START' })} />;
    case 'selectingPurpose':
      return (
        <PurposeView
          onSelect={(purpose) => dispatch({ type: 'SELECT_PURPOSE', purpose })}
          onCancel={() => dispatch({ type: 'RESET' })}
        />
      );
    case 'selectingTarget':
      return (
        <TargetView
          onSelect={(target) => dispatch({ type: 'SELECT_TARGET', target })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      );
    case 'inputVisitorInfo':
      return (
        <VisitorInfoView
          initial={data.visitor}
          onSubmit={(visitor) => dispatch({ type: 'SUBMIT_VISITOR_INFO', visitor })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      );
    case 'confirming':
      return (
        <ConfirmView
          data={data}
          onConfirm={() => dispatch({ type: 'CONFIRM' })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      );
    case 'calling':
      return <CallingView target={data.target?.label ?? ''} />;
    case 'connected':
      return <ConnectedView target={data.target?.label ?? ''} onComplete={complete} />;
    case 'timeout':
    case 'failed':
      return (
        <ResultView
          outcome={data.state}
          onFallback={() => dispatch({ type: 'USE_FALLBACK' })}
          onReset={() => dispatch({ type: 'RESET' })}
        />
      );
    case 'fallback':
      return <FallbackView onReset={() => dispatch({ type: 'RESET' })} />;
    case 'cancelled':
      return <EndView testid="completed" title="受付をキャンセルしました" />;
    case 'completed':
      return <EndView testid="completed" title="受付が完了しました" lead="ありがとうございました" />;
    default:
      return null;
  }
}

/* ---------- 各画面 (issue #11–#15) ---------- */

function IdleView({ onStart }: { onStart: () => void }) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <h1 className="screen__title">受付</h1>
      <p className="screen__lead">ようこそ。画面にタッチして受付を開始してください。</p>
      <button type="button" className="btn btn--primary" data-testid="start-reception" onClick={onStart}>
        受付を開始する
      </button>
    </div>
  );
}

function PurposeView({
  onSelect,
  onCancel,
}: {
  onSelect: (p: ReceptionPurposeId) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <h1 className="screen__title">ご用件をお選びください</h1>
      <div className="screen__body">
        <div className="card-grid">
          {RECEPTION_PURPOSES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="card"
              data-testid={`purpose-${p.id}`}
              onClick={() => onSelect(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="purpose-cancel" onClick={onCancel}>
          最初に戻る
        </button>
      </div>
    </>
  );
}

function TargetView({ onSelect, onBack }: { onSelect: (t: Target) => void; onBack: () => void }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchStaff(MOCK_STAFF, query), [query]);
  const departments = useMemo(() => MOCK_DEPARTMENTS.filter((d) => d.enabled), []);

  return (
    <>
      <h1 className="screen__title">担当者・部署をお選びください</h1>
      <div className="screen__body">
        <div className="field">
          <label className="field__label" htmlFor="staff-search">
            担当者を検索（氏名・よみがな・英字）
          </label>
          <input
            id="staff-search"
            className="input"
            data-testid="staff-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例: さとう / Sato"
            autoComplete="off"
          />
        </div>

        {results.length > 0 ? (
          <div className="card-grid">
            {results.map((s) => (
              <button
                key={s.id}
                type="button"
                className="card"
                data-testid={`staff-${s.id}`}
                onClick={() => onSelect({ type: 'staff', id: s.id, label: s.displayName })}
              >
                {s.displayName}
                <span className="card__sub">{MOCK_DEPARTMENTS.find((d) => d.id === s.departmentId)?.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="notice notice--warning" data-testid="staff-empty">
            該当する担当者が見つかりません。部署または代表窓口をお選びください。
          </div>
        )}

        <h2 style={{ fontSize: 'var(--font-lg)', margin: 0 }}>部署から選ぶ</h2>
        <div className="card-grid">
          {departments.map((d) => (
            <button
              key={d.id}
              type="button"
              className="card"
              data-testid={`dept-${d.id}`}
              onClick={() => onSelect({ type: 'department', id: d.id, label: d.name })}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="target-back" onClick={onBack}>
          戻る
        </button>
      </div>
    </>
  );
}

function VisitorInfoView({
  initial,
  onSubmit,
  onBack,
}: {
  initial?: VisitorInfo;
  onSubmit: (v: VisitorInfo) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const valid = name.trim().length > 0;

  return (
    <>
      <h1 className="screen__title">来訪者情報を入力してください</h1>
      <div className="screen__body">
        <div className="field">
          <label className="field__label" htmlFor="visitor-name">
            お名前（必須）
          </label>
          <input
            id="visitor-name"
            className="input"
            data-testid="visitor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="visitor-company">
            会社名（任意）
          </label>
          <input
            id="visitor-company"
            className="input"
            data-testid="visitor-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="visitor-note">
            ご用件メモ（任意）
          </label>
          <input
            id="visitor-note"
            className="input"
            data-testid="visitor-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="visitor-back" onClick={onBack}>
          戻る
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="to-confirm"
          disabled={!valid}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              company: company.trim() || undefined,
              note: note.trim() || undefined,
            })
          }
        >
          確認へ進む
        </button>
      </div>
    </>
  );
}

function ConfirmView({
  data,
  onConfirm,
  onBack,
}: {
  data: FlowData;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const purposeLabel = RECEPTION_PURPOSES.find((p) => p.id === data.purpose)?.label ?? '-';
  return (
    <>
      <h1 className="screen__title">内容をご確認ください</h1>
      <div className="screen__body">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-md)', fontSize: 'var(--font-lg)' }}>
          <dt className="card__sub">ご用件</dt>
          <dd style={{ margin: 0 }}>{purposeLabel}</dd>
          <dt className="card__sub">呼び出し先</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-target">
            {data.target?.label}
          </dd>
          <dt className="card__sub">お名前</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-name">
            {data.visitor?.name}
          </dd>
          {data.visitor?.company ? (
            <>
              <dt className="card__sub">会社名</dt>
              <dd style={{ margin: 0 }}>{data.visitor.company}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="confirm-back" onClick={onBack}>
          修正する
        </button>
        <button type="button" className="btn btn--primary" data-testid="confirm-call" onClick={onConfirm}>
          この内容で呼び出す
        </button>
      </div>
    </>
  );
}

function CallingView({ target }: { target: string }) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <h1 className="screen__title" data-testid="calling">
        呼び出し中…
      </h1>
      <p className="screen__lead">{target} を呼び出しています。少々お待ちください。</p>
    </div>
  );
}

function ConnectedView({ target, onComplete }: { target: string; onComplete: () => void }) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div className="notice notice--success" data-testid="result-connected">
        {target} が応答しました。まもなくお越しになります。
      </div>
      <button type="button" className="btn btn--primary" data-testid="complete" onClick={onComplete}>
        受付を終了する
      </button>
    </div>
  );
}

function ResultView({
  outcome,
  onFallback,
  onReset,
}: {
  outcome: 'timeout' | 'failed';
  onFallback: () => void;
  onReset: () => void;
}) {
  const message =
    outcome === 'timeout'
      ? '応答がありませんでした。別の方法でお呼びすることもできます。'
      : '呼び出しに失敗しました。別の方法でお呼びすることもできます。';
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div className="notice notice--danger" data-testid={`result-${outcome}`}>
        {message}
      </div>
      <div className="screen__footer" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn btn--secondary" data-testid="use-fallback" onClick={onFallback}>
          代替の連絡先へ
        </button>
        <button type="button" className="btn btn--ghost" data-testid="result-reset" onClick={onReset}>
          最初に戻る
        </button>
      </div>
    </div>
  );
}

function FallbackView({ onReset }: { onReset: () => void }) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div className="notice notice--warning" data-testid="fallback">
        代表窓口にお繋ぎします。受付スタッフが対応いたしますので、しばらくお待ちください。
      </div>
      <button type="button" className="btn btn--ghost" data-testid="fallback-reset" onClick={onReset}>
        最初に戻る
      </button>
    </div>
  );
}

function EndView({ testid, title, lead }: { testid: string; title: string; lead?: string }) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <h1 className="screen__title" data-testid={testid}>
        {title}
      </h1>
      {lead ? <p className="screen__lead">{lead}</p> : null}
    </div>
  );
}
