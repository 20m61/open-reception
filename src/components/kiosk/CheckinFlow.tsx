'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  transition,
  type CheckinEvent,
  type CheckinState,
} from '@/domain/checkin/state';
import type { CheckinSummary, CheckinFailureReason } from '@/domain/checkin/types';
import type { QrScanner, ScanError } from '@/domain/checkin/scanner';
import { MockQrScanner } from '@/lib/checkin/mock-scanner';

/**
 * QR チェックインフロー (issue #98, increment 1)。
 *
 * 状態機械（src/domain/checkin/state.ts）に沿って
 * 受付方法選択 → カメラ権限確認 → QR 読み取り → 予約取得 → 予約内容確認 → 呼び出し、
 * と各エラー / フォールバック遷移を描画する。
 *
 * scanner は**注入可能**（既定は inc1 の MockQrScanner）。実カメラ + デコードは
 * increment 2 で interface を変えずに差し替える（docs/qr-checkin-design.md §5）。
 *
 * 確認操作必須・カメラ拒否でも通常受付へ完走・完了/キャンセル後は個人情報を残さない。
 */

/** 受付方法選択で「通常受付」を選んだとき / フォールバック時に呼ばれる。 */
export type CheckinFlowProps = {
  /** 注入する QR スキャナ（テスト・実機差し替え用）。既定は mock。 */
  scanner?: QrScanner;
  /** 「通常受付」へ切り替えるときのハンドラ（既存フローへ委譲）。 */
  onUseManual?: () => void;
  /** 待機画面へ戻すときのハンドラ。 */
  onExit?: () => void;
};

type FlowData = {
  state: CheckinState;
  /** 読み取った QR payload（確認後の confirm 送信に使う。完了/キャンセルで破棄）。 */
  payload?: string;
  summary?: CheckinSummary;
  scanError?: ScanError;
};

/** ペイロードを伴うイベントは個別に持ち、それ以外は単純な type のみ。 */
type SimpleEvent = Exclude<CheckinEvent, 'QR_DETECTED' | 'SCAN_ERROR' | 'RESERVATION_OK'>;

type Action =
  | { type: SimpleEvent }
  | { type: 'QR_DETECTED'; payload: string }
  | { type: 'SCAN_ERROR'; error: ScanError }
  | { type: 'RESERVATION_OK'; summary: CheckinSummary };

const INITIAL: FlowData = { state: 'idle' };

function reducer(data: FlowData, action: Action): FlowData {
  const next = transition(data.state, action.type as CheckinEvent);
  if (next === null) return data; // 不正遷移は無視（画面を壊さない）。

  switch (action.type) {
    case 'QR_DETECTED':
      return { ...data, state: next, payload: action.payload, scanError: undefined };
    case 'SCAN_ERROR':
      return { ...data, state: next, scanError: action.error };
    case 'RESERVATION_OK':
      return { ...data, state: next, summary: action.summary };
    case 'RESET':
    case 'CANCEL':
      // 個人情報を画面に残さない（payload / summary を破棄）。
      return action.type === 'RESET'
        ? INITIAL
        : { state: next };
    default:
      return { ...data, state: next };
  }
}

/** 解決失敗理由 → 状態機械イベント（いずれもペイロードを伴わない）。 */
const REASON_EVENT: Record<CheckinFailureReason, SimpleEvent> = {
  expired: 'RESERVATION_EXPIRED',
  used: 'RESERVATION_USED',
  revoked: 'RESERVATION_REVOKED',
  invalid: 'RESERVATION_INVALID',
  not_found: 'RESERVATION_INVALID',
};

export function CheckinFlow({ scanner, onUseManual, onExit }: CheckinFlowProps) {
  const [data, dispatch] = useReducer(reducer, INITIAL);
  // 注入されたスキャナ（既定は mock）。再レンダーで作り直さない。
  const scannerRef = useRef<QrScanner>(scanner ?? new MockQrScanner());

  // scanning 状態の間だけスキャナを起動し、離脱時に必ず停止する（カメラ解放）。
  useEffect(() => {
    if (data.state !== 'scanning') return;
    const s = scannerRef.current;
    let stopped = false;
    void s.start(
      (text) => {
        if (!stopped) dispatch({ type: 'QR_DETECTED', payload: text });
      },
      (error) => {
        if (!stopped) dispatch({ type: 'SCAN_ERROR', error });
      },
    );
    return () => {
      stopped = true;
      void s.stop();
    };
  }, [data.state]);

  // resolving になったら API を叩いてサマリ or 失敗理由を反映する。
  useEffect(() => {
    if (data.state !== 'resolving' || !data.payload) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/checkin/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: data.payload }),
        });
        if (cancelled) return;
        if (res.ok) {
          const { summary } = (await res.json()) as { summary: CheckinSummary };
          dispatch({ type: 'RESERVATION_OK', summary });
          return;
        }
        if (res.status === 503) {
          dispatch({ type: 'RESOLVE_NETWORK_ERROR' });
          return;
        }
        const { error } = (await res.json()) as { error: CheckinFailureReason };
        dispatch({ type: REASON_EVENT[error] ?? 'RESERVATION_INVALID' });
      } catch {
        if (!cancelled) dispatch({ type: 'RESOLVE_NETWORK_ERROR' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.state, data.payload]);

  // calling になったら confirm（使用済み化 + 受付セッション接続）を実行する。
  useEffect(() => {
    if (data.state !== 'calling' || !data.payload) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/checkin/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: data.payload }),
        });
        if (cancelled) return;
        if (res.ok) dispatch({ type: 'CALL_DONE' });
        else dispatch({ type: 'CALL_FAILED' });
      } catch {
        if (!cancelled) dispatch({ type: 'CALL_FAILED' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.state, data.payload]);

  const useManual = useCallback(() => {
    dispatch({ type: 'USE_MANUAL' });
    onUseManual?.();
  }, [onUseManual]);

  const exit = useCallback(() => {
    dispatch({ type: 'RESET' });
    onExit?.();
  }, [onExit]);

  return renderCheckin(data, dispatch, useManual, exit);
}

function renderCheckin(
  data: FlowData,
  dispatch: React.Dispatch<Action>,
  useManual: () => void,
  exit: () => void,
) {
  switch (data.state) {
    case 'idle':
      return (
        <CenteredCard>
          <h1 className="screen__title">QR で受付</h1>
          <p className="screen__lead">予約 QR をお持ちの方はこちらから受付できます。</p>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="checkin-start"
            onClick={() => dispatch({ type: 'START' })}
          >
            受付を開始する
          </button>
          <button type="button" className="btn btn--ghost" data-testid="checkin-exit" onClick={exit}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'selectingMethod':
      return (
        <CenteredCard>
          <h1 className="screen__title">受付方法をお選びください</h1>
          <div className="card-grid">
            <button
              type="button"
              className="card"
              data-testid="method-qr"
              onClick={() => dispatch({ type: 'CHOOSE_QR' })}
            >
              QR で受付
            </button>
            <button
              type="button"
              className="card"
              data-testid="method-manual"
              onClick={useManual}
            >
              通常受付（手入力）
            </button>
          </div>
          <button type="button" className="btn btn--ghost" data-testid="method-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'checkingCamera':
      return (
        <CenteredCard>
          <h1 className="screen__title">カメラの使用を許可してください</h1>
          <p className="screen__lead">QR を読み取るためにカメラを使用します。映像は保存しません。</p>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="camera-grant"
            onClick={() => dispatch({ type: 'CAMERA_GRANTED' })}
          >
            カメラを許可して読み取りへ
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="camera-deny"
            onClick={() => dispatch({ type: 'CAMERA_DENIED' })}
          >
            カメラを使わない
          </button>
          <button type="button" className="btn btn--ghost" data-testid="camera-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'scanning':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-scanning">QR を読み取っています…</h1>
          <p className="screen__lead">予約 QR をカメラにかざしてください。</p>
          <button type="button" className="btn btn--ghost" data-testid="scan-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            やめる
          </button>
        </CenteredCard>
      );
    case 'resolving':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-resolving">予約を確認しています…</h1>
        </CenteredCard>
      );
    case 'confirming':
      return (
        <ConfirmReservationView
          summary={data.summary}
          onConfirm={() => dispatch({ type: 'CONFIRM' })}
          onRescan={() => dispatch({ type: 'RESCAN' })}
          onCancel={() => dispatch({ type: 'CANCEL' })}
        />
      );
    case 'calling':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-calling">担当者を呼び出しています…</h1>
          <p className="screen__lead">少々お待ちください。</p>
        </CenteredCard>
      );
    case 'completed':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-completed">受付が完了しました</h1>
          <p className="screen__lead">ありがとうございました。</p>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'cancelled':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-cancelled">受付をキャンセルしました</h1>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'manualFallback':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-manual">通常受付に切り替えます</h1>
          <p className="screen__lead">手入力での受付にお進みください。</p>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            最初に戻る
          </button>
        </CenteredCard>
      );
    case 'cameraError':
    case 'scanError':
    case 'expiredError':
    case 'usedError':
    case 'revokedError':
    case 'networkError':
      return (
        <ErrorView
          state={data.state}
          onUseManual={useManual}
          onRetry={() => dispatch({ type: 'RETRY' })}
          onReset={exit}
        />
      );
    default:
      return null;
  }
}

/** 予約内容確認画面（必要最小限の情報のみ）。確認操作で初めて呼び出しへ進む。 */
function ConfirmReservationView({
  summary,
  onConfirm,
  onRescan,
  onCancel,
}: {
  summary?: CheckinSummary;
  onConfirm: () => void;
  onRescan: () => void;
  onCancel: () => void;
}) {
  if (!summary) return null;
  return (
    <>
      <h1 className="screen__title">ご予約内容をご確認ください</h1>
      <div className="screen__body">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-md)', fontSize: 'var(--font-lg)' }}>
          <dt className="card__sub">お名前</dt>
          <dd style={{ margin: 0 }} data-testid="checkin-confirm-name">{summary.visitorName}</dd>
          {summary.companyName ? (
            <>
              <dt className="card__sub">会社名</dt>
              <dd style={{ margin: 0 }} data-testid="checkin-confirm-company">{summary.companyName}</dd>
            </>
          ) : null}
          <dt className="card__sub">ご予定</dt>
          <dd style={{ margin: 0 }} data-testid="checkin-confirm-visitat">{formatVisitAt(summary.visitAt)}</dd>
        </dl>
        <p className="card__sub">内容に間違いがなければ「この内容で呼び出す」を押してください。</p>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="checkin-rescan" onClick={onRescan}>
          読み直す
        </button>
        <button type="button" className="btn btn--secondary" data-testid="checkin-cancel" onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="btn btn--primary" data-testid="checkin-confirm" onClick={onConfirm}>
          この内容で呼び出す
        </button>
      </div>
    </>
  );
}

/** エラー種別ごとの文言（受け入れ条件: 期限切れ/使用済み/失効/不正/通信断/カメラ不可を区別）。 */
const ERROR_MESSAGE: Record<string, string> = {
  cameraError: 'カメラを使用できませんでした。通常受付でお進みいただけます。',
  scanError: 'QR を読み取れませんでした。もう一度お試しいただくか、通常受付をご利用ください。',
  expiredError: 'この QR は有効期限が切れています。受付スタッフにお問い合わせください。',
  usedError: 'この QR はすでに受付に使用されています。受付スタッフにお問い合わせください。',
  revokedError: 'この QR は無効化されています。受付スタッフにお問い合わせください。',
  networkError: '通信に失敗しました。通常受付でお進みいただけます。',
};

function ErrorView({
  state,
  onUseManual,
  onRetry,
  onReset,
}: {
  state: CheckinState;
  onUseManual: () => void;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div className="notice notice--danger" data-testid={`checkin-error-${state}`}>
        {ERROR_MESSAGE[state] ?? 'エラーが発生しました。'}
      </div>
      <div className="screen__footer" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn btn--primary" data-testid="checkin-error-manual" onClick={onUseManual}>
          通常受付へ
        </button>
        <button type="button" className="btn btn--secondary" data-testid="checkin-error-retry" onClick={onRetry}>
          やり直す
        </button>
        <button type="button" className="btn btn--ghost" data-testid="checkin-error-reset" onClick={onReset}>
          最初に戻る
        </button>
      </div>
    </div>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="screen__body"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 'var(--space-lg)' }}
    >
      {children}
    </div>
  );
}

function formatVisitAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}
