'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  transition,
  type CheckinEvent,
  type CheckinState,
} from '@/domain/checkin/state';
import type { CheckinSummary, CheckinFailureReason } from '@/domain/checkin/types';
import type { QrScanner, ScanError } from '@/domain/checkin/scanner';
import { CameraQrScanner } from '@/lib/checkin/camera-scanner';
import { checkinConversationTurnFor } from '@/domain/reception/ui-contract';
import type { MotionKey } from '@/domain/motion/types';
import { DEFAULT_LOCALE, makeT, type Locale, type MessageKey } from '@/lib/i18n';
import type { KioskLayout } from './layout';
import { AvatarGuide } from './avatar/AvatarGuide';

/**
 * QR チェックインフロー (issue #98, increment 2)。
 *
 * 状態機械（src/domain/checkin/state.ts）に沿って
 * 受付方法選択 → カメラ権限確認 → QR 読み取り → 予約取得 → 予約内容確認 → 呼び出し、
 * と各エラー / フォールバック遷移を描画する。
 *
 * scanner は**注入可能**。既定は increment 2 で結線した実カメラ + jsQR デコードの
 * CameraQrScanner（getUserMedia → フレーム → デコード → token）。テスト / フォールバック
 * 用に MockQrScanner を注入できる（interface は inc1 から不変。docs/qr-checkin-design.md §5）。
 * 映像はローカル処理のみ・非送信・非保存。
 *
 * 確認操作必須・カメラ拒否でも通常受付へ完走・完了/キャンセル後は個人情報を残さない。
 */

/** 受付方法選択で「通常受付」を選んだとき / フォールバック時に呼ばれる。 */
export type CheckinFlowProps = {
  /** 注入する QR スキャナ（テスト・実機差し替え用）。既定は実カメラ CameraQrScanner。 */
  scanner?: QrScanner;
  /** 「通常受付」へ切り替えるときのハンドラ（既存フローへ委譲）。 */
  onUseManual?: () => void;
  /** 待機画面へ戻すときのハンドラ。 */
  onExit?: () => void;
  /** 表示言語（#103）。アバター継続レールの字幕 lang などに使う。 */
  locale?: Locale;
  /** 画面種別レイアウト（#124）。横向きはアバターを左レール、縦向きは控えめな companion にする。 */
  layout?: KioskLayout;
  /** アバター VRM URL（無ければ静止画/プレースホルダ）。実アセット検証は #65。 */
  vrmUrl?: string;
  /** VRM 不可/失敗時の静止画 URL。 */
  avatarFallbackUrl?: string;
  /** モーションキー → 解決済みモーション URL（#31）。 */
  motionUrls?: Partial<Record<MotionKey, string>>;
  /** 既定モーション URL（キー未割当時の fallback）。 */
  defaultMotionUrl?: string;
};

/** `renderCheckin` へ渡す描画用状態（CheckinFlow.test.tsx から直接構成してテストする）。 */
export type FlowData = {
  state: CheckinState;
  /** 読み取った QR payload（確認後の confirm 送信に使う。完了/キャンセルで破棄）。 */
  payload?: string;
  summary?: CheckinSummary;
  scanError?: ScanError;
};

/** ペイロードを伴うイベントは個別に持ち、それ以外は単純な type のみ。 */
type SimpleEvent = Exclude<CheckinEvent, 'QR_DETECTED' | 'SCAN_ERROR' | 'RESERVATION_OK'>;

/** `renderCheckin` へ渡す dispatch のアクション型（CheckinFlow.test.tsx から直接呼ぶために export）。 */
export type Action =
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

export function CheckinFlow({
  scanner,
  onUseManual,
  onExit,
  locale = DEFAULT_LOCALE,
  layout = 'ipad-portrait',
  vrmUrl,
  avatarFallbackUrl,
  motionUrls,
  defaultMotionUrl,
}: CheckinFlowProps) {
  const [data, dispatch] = useReducer(reducer, INITIAL);
  // 注入されたスキャナ（既定は実カメラ CameraQrScanner）。再レンダーで作り直さない。
  const scannerRef = useRef<QrScanner>(scanner ?? new CameraQrScanner());

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
        if (stopped) return;
        // 実カメラでは権限プロンプトが読み取り開始時に出る。カメラ拒否 / 未対応は
        // cameraError として区別し、それ以外（デコード失敗 / タイムアウト）は scanError。
        if (error.kind === 'camera_denied') dispatch({ type: 'CAMERA_DENIED' });
        else dispatch({ type: 'SCAN_ERROR', error });
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

  return (
    <CheckinShell
      state={data.state}
      locale={locale}
      layout={layout}
      vrmUrl={vrmUrl}
      avatarFallbackUrl={avatarFallbackUrl}
      motionUrls={motionUrls}
      defaultMotionUrl={defaultMotionUrl}
    >
      {renderCheckin(data, dispatch, useManual, exit, locale)}
    </CheckinShell>
  );
}

/**
 * QR 受付シェル（#361）。CheckinFlow を通常受付(KioskFlow)と同じアバター継続レール・字幕で
 * 提示し「別アプリ」に見せない。表示契約の真実源は ui-contract の `checkinConversationTurnFor`。
 *
 * レイアウト方針:
 *  - 横向き/大型: アバターを左レール(35%)として並置し、会話・操作を右(65%)へ寄せる（#361 の
 *    横向き会話継続レイアウトに合わせる）。レールは pointer-events:none で操作を妨げない。
 *  - 縦向き: 既存プロファイルを壊さないよう左下の控えめな companion として重ね、コンテンツは
 *    全幅で流す（縦置きのタッチ密集を避ける）。
 *
 * アバターの表情/モーション/在り方は checkin 状態の ReceptionState 代理(proxyState)経由で導出し、
 * 既存の AvatarGuide をそのまま再利用する。字幕は checkin 専用文言で上書きする（画面文言と一致）。
 */
function CheckinShell({
  state,
  locale,
  layout,
  vrmUrl,
  avatarFallbackUrl,
  motionUrls,
  defaultMotionUrl,
  children,
}: {
  state: CheckinState;
  locale: Locale;
  layout: KioskLayout;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  motionUrls?: Partial<Record<MotionKey, string>>;
  defaultMotionUrl?: string;
  children: React.ReactNode;
}) {
  const turn = checkinConversationTurnFor(state);
  const isRail = layout === 'ipad-landscape' || layout === 'large-display';

  const avatar = (
    <div
      className="checkin-shell__avatar"
      data-testid="checkin-avatar-rail"
      aria-hidden="true"
      style={isRail ? avatarRailStyle : avatarCompanionStyle}
    >
      <AvatarGuide
        screenState={turn.avatar.proxyState}
        locale={locale}
        vrmUrl={vrmUrl}
        fallbackImageUrl={avatarFallbackUrl}
        motionUrls={motionUrls}
        defaultMotionUrl={defaultMotionUrl}
        // 字幕は checkin 専用文言で上書きする（受付フローの avatar 既定文言とは別スロット。
        // 画面の見出し/リードと矛盾しないよう ui-contract の checkin 文言に一致させる）。
        guidanceOverride={{ text: turn.message.displayText }}
      />
    </div>
  );

  return (
    <div
      className="checkin-shell"
      data-testid="checkin-shell"
      data-checkin-state={turn.stateKey}
      data-checkin-presence={turn.avatar.presence}
      style={isRail ? shellRailStyle : shellStackStyle}
    >
      {avatar}
      <div className="checkin-shell__content" style={isRail ? contentRailStyle : contentStackStyle}>
        {children}
      </div>
    </div>
  );
}

// 横向き/大型: アバターを左レール(35%)として在席させる（#361 会話継続レイアウト）。
const shellRailStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  width: '100%',
  gap: 'var(--space-lg)',
};

// 縦向き: コンテンツ全幅 + 左下の控えめ companion（重ね置き）。
const shellStackStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  width: '100%',
};

const avatarRailStyle: React.CSSProperties = {
  width: '35%',
  maxWidth: '35vw',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
};

const avatarCompanionStyle: React.CSSProperties = {
  position: 'fixed',
  left: 'var(--space-md)',
  bottom: 'var(--space-md)',
  width: 150,
  maxWidth: '26vw',
  zIndex: 5,
  pointerEvents: 'none',
};

const contentRailStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-lg)',
};

const contentStackStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-lg)',
};

/**
 * QR 受付シェルの画面本体（issue #98 / #361 残 i18n）。
 *
 * `data`/`dispatch`/ハンドラのみに依存する純粋な描画関数（hooks を使わない）で、`renderToStaticMarkup`
 * で直接レンダーしてテストできる（プロジェクトに jsdom/RTL は無いため、`VoiceReadbackConfirm` と同じ
 * 静的マークアップ検証の流儀に合わせている）。`export` は CheckinFlow.test.tsx からの直接検証用。
 */
export function renderCheckin(
  data: FlowData,
  dispatch: React.Dispatch<Action>,
  useManual: () => void,
  exit: () => void,
  locale: Locale = DEFAULT_LOCALE,
) {
  const tr = makeT(locale);
  switch (data.state) {
    case 'idle':
      return (
        <CenteredCard>
          <h1 className="screen__title">{tr('checkin.idle.title')}</h1>
          <p className="screen__lead">{tr('checkin.idle.lead')}</p>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="checkin-start"
            onClick={() => dispatch({ type: 'START' })}
          >
            {tr('checkin.idle.start')}
          </button>
          <button type="button" className="btn btn--ghost" data-testid="checkin-exit" onClick={exit}>
            {tr('checkin.backToStart')}
          </button>
        </CenteredCard>
      );
    case 'selectingMethod':
      return (
        <CenteredCard>
          <h1 className="screen__title">{tr('checkin.method.title')}</h1>
          <div className="card-grid">
            <button
              type="button"
              className="card"
              data-testid="method-qr"
              onClick={() => dispatch({ type: 'CHOOSE_QR' })}
            >
              {tr('checkin.method.qr')}
            </button>
            <button
              type="button"
              className="card"
              data-testid="method-manual"
              onClick={useManual}
            >
              {tr('checkin.method.manual')}
            </button>
          </div>
          <button type="button" className="btn btn--ghost" data-testid="method-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            {tr('checkin.backToStart')}
          </button>
        </CenteredCard>
      );
    case 'checkingCamera':
      return (
        <CenteredCard>
          <h1 className="screen__title">{tr('checkin.camera.title')}</h1>
          <p className="screen__lead">{tr('checkin.camera.lead')}</p>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="camera-grant"
            onClick={() => dispatch({ type: 'CAMERA_GRANTED' })}
          >
            {tr('checkin.camera.grant')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="camera-deny"
            onClick={() => dispatch({ type: 'CAMERA_DENIED' })}
          >
            {tr('checkin.camera.deny')}
          </button>
          <button type="button" className="btn btn--ghost" data-testid="camera-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            {tr('checkin.backToStart')}
          </button>
        </CenteredCard>
      );
    case 'scanning':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-scanning">{tr('checkin.scanning.title')}</h1>
          <p className="screen__lead">{tr('checkin.scanning.lead')}</p>
          <button type="button" className="btn btn--ghost" data-testid="scan-cancel" onClick={() => dispatch({ type: 'CANCEL' })}>
            {tr('checkin.cancelAction')}
          </button>
        </CenteredCard>
      );
    case 'resolving':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-resolving">{tr('checkin.resolving.title')}</h1>
        </CenteredCard>
      );
    case 'confirming':
      return (
        <ConfirmReservationView
          summary={data.summary}
          locale={locale}
          onConfirm={() => dispatch({ type: 'CONFIRM' })}
          onRescan={() => dispatch({ type: 'RESCAN' })}
          onCancel={() => dispatch({ type: 'CANCEL' })}
        />
      );
    case 'calling':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-calling">{tr('checkin.calling.title')}</h1>
          <p className="screen__lead">{tr('checkin.calling.lead')}</p>
        </CenteredCard>
      );
    case 'completed':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-completed">{tr('checkin.completed.title')}</h1>
          <p className="screen__lead">{tr('checkin.completed.lead')}</p>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            {tr('checkin.backToStart')}
          </button>
        </CenteredCard>
      );
    case 'cancelled':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-cancelled">{tr('checkin.cancelled.title')}</h1>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            {tr('checkin.backToStart')}
          </button>
        </CenteredCard>
      );
    case 'manualFallback':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-manual">{tr('checkin.manualFallback.title')}</h1>
          <p className="screen__lead">{tr('checkin.manualFallback.lead')}</p>
          <button type="button" className="btn btn--ghost" data-testid="checkin-reset" onClick={exit}>
            {tr('checkin.backToStart')}
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
          locale={locale}
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
  locale,
  onConfirm,
  onRescan,
  onCancel,
}: {
  summary?: CheckinSummary;
  locale: Locale;
  onConfirm: () => void;
  onRescan: () => void;
  onCancel: () => void;
}) {
  if (!summary) return null;
  const tr = makeT(locale);
  return (
    <>
      <h1 className="screen__title">{tr('checkin.confirm.title')}</h1>
      <div className="screen__body">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-md)', fontSize: 'var(--font-lg)' }}>
          <dt className="card__sub">{tr('checkin.confirm.name')}</dt>
          <dd style={{ margin: 0 }} data-testid="checkin-confirm-name">{summary.visitorName}</dd>
          {summary.companyName ? (
            <>
              <dt className="card__sub">{tr('checkin.confirm.company')}</dt>
              <dd style={{ margin: 0 }} data-testid="checkin-confirm-company">{summary.companyName}</dd>
            </>
          ) : null}
          <dt className="card__sub">{tr('checkin.confirm.visitAt')}</dt>
          <dd style={{ margin: 0 }} data-testid="checkin-confirm-visitat">{formatVisitAt(summary.visitAt, locale)}</dd>
        </dl>
        <p className="card__sub">{tr('checkin.confirm.notice')}</p>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="checkin-rescan" onClick={onRescan}>
          {tr('checkin.confirm.rescan')}
        </button>
        <button type="button" className="btn btn--secondary" data-testid="checkin-cancel" onClick={onCancel}>
          {tr('checkin.cancelAction')}
        </button>
        <button type="button" className="btn btn--primary" data-testid="checkin-confirm" onClick={onConfirm}>
          {tr('checkin.confirm.submit')}
        </button>
      </div>
    </>
  );
}

/** エラー種別ごとの文言キー（受け入れ条件: 期限切れ/使用済み/失効/不正/通信断/カメラ不可を区別）。 */
const ERROR_MESSAGE_KEY: Partial<Record<CheckinState, MessageKey>> = {
  cameraError: 'checkin.error.camera',
  scanError: 'checkin.error.scan',
  expiredError: 'checkin.error.expired',
  usedError: 'checkin.error.used',
  revokedError: 'checkin.error.revoked',
  networkError: 'checkin.error.network',
};

function ErrorView({
  state,
  locale,
  onUseManual,
  onRetry,
  onReset,
}: {
  state: CheckinState;
  locale: Locale;
  onUseManual: () => void;
  onRetry: () => void;
  onReset: () => void;
}) {
  const tr = makeT(locale);
  const key = ERROR_MESSAGE_KEY[state];
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div className="notice notice--danger" data-testid={`checkin-error-${state}`}>
        {key ? tr(key) : tr('checkin.error.generic')}
      </div>
      <div className="screen__footer" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn btn--primary" data-testid="checkin-error-manual" onClick={onUseManual}>
          {tr('checkin.error.useManual')}
        </button>
        <button type="button" className="btn btn--secondary" data-testid="checkin-error-retry" onClick={onRetry}>
          {tr('checkin.error.retry')}
        </button>
        <button type="button" className="btn btn--ghost" data-testid="checkin-error-reset" onClick={onReset}>
          {tr('checkin.backToStart')}
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

/** 日付整形用の locale → BCP47（`OutOfHoursView` と同じ方針。TTS 用コードとは別軸）。 */
const INTL_LOCALE: Record<Locale, string> = {
  ja: 'ja-JP',
  en: 'en-US',
  ko: 'ko-KR',
  zh: 'zh-CN',
  'ja-simple': 'ja-JP',
};

function formatVisitAt(iso: string, locale: Locale): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(INTL_LOCALE[locale], { dateStyle: 'medium', timeStyle: 'short' });
}
