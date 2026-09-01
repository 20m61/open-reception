'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { confirmAndCall } from '@/lib/checkin/place-call';
import { decidePollAction, CALL_STATUS_POLL_INTERVAL_MS } from '@/domain/reception/call-poll';
import {
  clampCallingStageThresholds,
  callingStageQueryFromSearch,
  type CallingStage,
  type CallingStageThresholds,
} from '@/domain/reception/calling-experience';
import { useCallingNoticeHold } from './use-calling-notice-hold';
import { callingStageMessage } from './reception-screens';
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
import { checkinSubtitleFor } from './conversation-turn';
import { EscapeBar } from './EscapeBar';
import { checkinEscapesFor } from './quick-actions';
import {
  checkinCallFailureMessageKeyFor,
  type CheckinCallFailureReason,
} from '@/domain/checkin/failure';

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
  // 呼び出し失敗の理由。**状態は増やさず**（`networkError` のまま）、文言だけを出し分ける
  // （第 36 wave の通常受付と同じ方針）。RESET / RETRY で消す。
  const [callFailureReason, setCallFailureReason] = useState<CheckinCallFailureReason | null>(null);
  /** 実 PSTN の結果待ち中の受付 ID（#736）。null = 待っていない。 */
  const [pendingReceptionId, setPendingReceptionId] = useState<string | null>(null);
  /**
   * timeout / unanswered が確定したが、予告の保持がまだ済んでいない (#832)。
   * 発火は `useCallingNoticeHold`。ここへ `server` などを載せない。
   */
  const [pendingTimeout, setPendingTimeout] = useState<{ sessionId: string } | null>(null);
  const [callingStageQueryOverride, setCallingStageQueryOverride] = useState<
    Partial<CallingStageThresholds>
  >({});
  useEffect(() => {
    setCallingStageQueryOverride(callingStageQueryFromSearch(window.location.search));
  }, []);
  const callingStageThresholds = useMemo(
    () => clampCallingStageThresholds(callingStageQueryOverride),
    [callingStageQueryOverride],
  );
  const callingStageState = useCallingNoticeHold({
    active: data.state === 'calling',
    thresholds: callingStageThresholds,
    pendingSessionId: pendingTimeout?.sessionId ?? null,
    onFire: () => {
      setPendingTimeout(null);
      setCallFailureReason('unanswered');
      dispatch({ type: 'CALL_FAILED' });
    },
  });
  useEffect(() => {
    if (data.state !== 'calling') setPendingTimeout(null);
  }, [data.state]);
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

  /**
   * calling になったら confirm（使用済み化 + 受付セッション作成）し、**続けて実際に呼び出す**。
   *
   * 🔴 **confirm だけで完了にしない (#736)。** かつてここは confirm が 201 を返した時点で
   * `CALL_DONE` を dispatch していた。`/api/kiosk/receptions/:id/call` は**一度も呼ばれず**、
   * それでも「担当者を呼び出しています…」→「受付が完了しました」と表示していた。
   * **誰も呼ばれていないのに全員が受付完了する。** 通常受付で `unrouted`（#738）・
   * `out_of_hours`（#747）を塞いだのと同型だが、QR 経路は常にこの状態だった。
   *
   * 呼び出しは通常受付とまったく同じ `/call` ルートへ委ねる（営業時間ガード・停止スイッチ・
   * 取次・失敗理由をそのまま再利用し、二重実装を作らない）。
   */
  useEffect(() => {
    if (data.state !== 'calling' || !data.payload) return;
    let cancelled = false;
    void (async () => {
      const result = await confirmAndCall(data.payload!);
      if (cancelled) return;
      if (result.kind === 'connected') {
        dispatch({ type: 'CALL_DONE' });
        return;
      }
      if (result.kind === 'failed') {
        if (result.reason === 'unanswered') {
          // 同期 timeout も予告保持ゲートへ (#832)。未応答以外は即失敗。
          setPendingTimeout({ sessionId: 'checkin' });
          return;
        }
        setCallFailureReason(result.reason);
        dispatch({ type: 'CALL_FAILED' });
        return;
      }
      // 実 PSTN は 1 手撃った時点では結果が無い（webhook で後から届く）。
      // サーバの確定を `/status` の読みで待つ。**待っている間は完了にしない。**
      setPendingReceptionId(result.receptionId);
    })();
    return () => {
      cancelled = true;
    };
  }, [data.state, data.payload]);

  /**
   * 実 PSTN の結果待ち (#736 / #647)。判断は `decidePollAction` に閉じている
   * （経過時間で結果を作らない ── 状態を決めるのはサーバの応答だけ）。
   */
  useEffect(() => {
    if (pendingReceptionId === null) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/kiosk/receptions/${pendingReceptionId}/status`);
          if (cancelled) return;
          const body = res.ok ? ((await res.json()) as { state?: string }) : undefined;
          const action = decidePollAction(body?.state ?? '', Date.now() - startedAt);
          if (action.kind === 'wait') return;
          setPendingReceptionId(null);
          if (action.kind === 'give_up') {
            // 結果を断定しない。**「判定できなかった」を未応答と混同しない。**
            setCallFailureReason('server');
            dispatch({ type: 'CALL_FAILED' });
            return;
          }
          if (action.event === 'CALL_CONNECTED') {
            dispatch({ type: 'CALL_DONE' });
            return;
          }
          if (action.event === 'CALL_TIMEOUT') {
            setPendingTimeout({ sessionId: pendingReceptionId });
            return;
          }
          setCallFailureReason('server');
          dispatch({ type: 'CALL_FAILED' });
        } catch {
          // 1 回の取得失敗では倒さない（次の間隔で再取得する）。上限は decidePollAction が持つ。
        }
      })();
    }, CALL_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingReceptionId]);

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
      // 逃げ道は RESET のみ（契約）。`exit` が RESET + QR モード離脱を同時に行うので、
      // 押した来訪者は kiosk 待機画面へ帰る（QR シェルの中で idle に留まらない）。
      onEscape={exit}
    >
      {renderCheckin({
        data,
        dispatch,
        useManual,
        exit,
        locale,
        callFailureReason,
        onClearFailureReason: () => setCallFailureReason(null),
        callingStage: callingStageState.stage,
      })}
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
  onEscape,
  children,
}: {
  state: CheckinState;
  locale: Locale;
  layout: KioskLayout;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  motionUrls?: Partial<Record<MotionKey, string>>;
  defaultMotionUrl?: string;
  /** 逃げ道バーの選択（現状は RESET のみ＝ kiosk 待機へ帰る）。 */
  onEscape: (event: string) => void;
  children: React.ReactNode;
}) {
  // 字幕は来訪者の言語で解決して注入する (#361 AC2)。渡さないと契約の ja 既定文言が出て、
  // 見出し・リードだけが訳された「日本語で話しかけてくる英語画面」になる。
  const turn = checkinConversationTurnFor(state, {
    message: { displayText: checkinSubtitleFor(state, locale) },
  });
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
      style={shellOuterStyle}
    >
      {/*
        アバターと会話・操作の並び（横向きは 35%/65% のレール、縦向きは重ね置き）。
        **逃げ道バーはこの内側に入れない。** バーは `position: sticky; bottom: 0` で列方向の
        流れに乗る前提なので、行 flex の子にすると右側の縦カラムとして描かれ、右上の
        「見やすさ設定」に重なる（VRT が実際にこの退行を捕まえた）。
      */}
      <div style={isRail ? shellRailStyle : shellStackStyle}>
        {avatar}
        <div className="checkin-shell__content" style={isRail ? contentRailStyle : contentStackStyle}>
          {children}
        </div>
      </div>
      {/*
        常設逃げ道バー (#361 AC2)。**画面分岐の外**に置く（受付側が #39 で同じ是正をした）。
        以前は各ターンが `CANCEL`/`exit` ボタンを手書きしており、ターンが増えるたびに
        入れ忘れる余地があった。ここに置けば構造として全ターンへ常設される。
        出す項目は契約（`checkinEscapeHatchesFor`）由来で、受付と同じ「最初に戻る」を出す。
      */}
      <EscapeBar
        regionTestId="checkin-escape-bar"
        locale={locale}
        items={checkinEscapesFor(state).map((escape) => ({ id: escape.event, ...escape }))}
        onSelect={onEscape}
      />
    </div>
  );
}

// シェルの外枠。列方向にして「アバター＋会話」の並びと常設バーを縦に積む（バーの
// sticky bottom が効く流れを作る）。
const shellOuterStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  width: '100%',
};

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
export type RenderCheckinProps = {
  data: FlowData;
  dispatch: React.Dispatch<Action>;
  useManual: () => void;
  exit: () => void;
  locale?: Locale;
  /** 呼び出し失敗の理由。読み取り段階のエラーでは null（状態から文言を引く）。 */
  callFailureReason?: CheckinCallFailureReason | null;
  /** 再試行時に理由を捨てる（前回の失敗の説明を次の試行へ持ち越さない）。 */
  onClearFailureReason?: () => void;
  /** 呼び出し中の経過段階 (#832)。calling 以外では無視。 */
  callingStage?: CallingStage;
};

/**
 * 画面の描画（hooks を使わない純関数）。
 *
 * **位置引数ではなく props オブジェクトで受ける。** 第 28 wave (#445) で `renderScreen` の
 * 位置引数が 29 個まで膨れて可読性を失った前例があるため、増える前に寄せる。
 */
export function renderCheckin({
  data,
  dispatch,
  useManual,
  exit,
  locale = DEFAULT_LOCALE,
  callFailureReason = null,
  onClearFailureReason,
  callingStage = 'dialing',
}: RenderCheckinProps) {
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
        </CenteredCard>
      );
    case 'scanning':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-scanning">{tr('checkin.scanning.title')}</h1>
          <p className="screen__lead">{tr('checkin.scanning.lead')}</p>
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
          <div data-testid="checkin-calling" data-calling-stage={callingStage}>
            <h1 className="screen__title">{tr('checkin.calling.title')}</h1>
            <p className="screen__lead">
              {callingStage === 'dialing'
                ? tr('checkin.calling.lead')
                : callingStageMessage(callingStage, '', locale, {})}
            </p>
            <span className="calling-pulse" data-testid="calling-pulse" aria-hidden="true">
              <span className="calling-pulse__dot" />
              <span className="calling-pulse__dot" />
              <span className="calling-pulse__dot" />
            </span>
          </div>
        </CenteredCard>
      );
    case 'completed':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-completed">{tr('checkin.completed.title')}</h1>
          <p className="screen__lead">{tr('checkin.completed.lead')}</p>
        </CenteredCard>
      );
    case 'cancelled':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-cancelled">{tr('checkin.cancelled.title')}</h1>
        </CenteredCard>
      );
    case 'manualFallback':
      return (
        <CenteredCard>
          <h1 className="screen__title" data-testid="checkin-manual">{tr('checkin.manualFallback.title')}</h1>
          <p className="screen__lead">{tr('checkin.manualFallback.lead')}</p>
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
          callFailureReason={callFailureReason}
          locale={locale}
          onUseManual={useManual}
          onRetry={() => {
            onClearFailureReason?.();
            dispatch({ type: 'RETRY' });
          }}
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
  callFailureReason,
  locale,
  onUseManual,
  onRetry,
}: {
  state: CheckinState;
  /** 呼び出し失敗の理由。読み取り段階のエラーでは null（状態から文言を引く）。 */
  callFailureReason: CheckinCallFailureReason | null;
  locale: Locale;
  onUseManual: () => void;
  onRetry: () => void;
}) {
  const tr = makeT(locale);
  // 呼び出し失敗は理由ごとに文言を変える（差分 D）。理由が無い＝読み取り段階のエラーなので
  // 従来どおり状態から引く。
  const key =
    callFailureReason === null
      ? ERROR_MESSAGE_KEY[state]
      : checkinCallFailureMessageKeyFor(callFailureReason);
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
        {/* 「最初に戻る」は常設バーへ統合した (#361 AC2)。ここは前進系だけを置く。 */}
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
