'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  RECEPTION_PURPOSES,
  type ReceptionPurposeId,
  type ReceptionTargetType,
  type VisitorInfo,
} from '@/domain/reception/session';
import {
  shouldResetOnInactivity,
  transition,
  type ReceptionEvent,
  type ReceptionState,
} from '@/domain/reception/state';
import { motionKeyForState, resolveMotionUrl, type MotionKey } from '@/domain/motion/types';
import { primeSpeech, speak, type SpeakSettings } from './speech';
import { VrmAvatarViewer } from './VrmAvatarViewer';
import { KioskCallView } from './KioskCallView';
import { CheckinFlow } from './CheckinFlow';
import { MockSttAdapter } from '@/adapters/speech/mock-stt';
import { useStaffResponse } from './useStaffResponse';
import type { StaffResponseResult } from '@/domain/reception/staff-response';
import { PurposeSelector } from './custom-flow/PurposeSelector';
import { VisitorInfoForm } from './custom-flow/VisitorInfoForm';
import type { KioskFlow as KioskCustomFlow, FlowFieldValues } from './custom-flow/types';
import { SignageDisplay } from './signage/SignageDisplay';
import { usePresenceCamera } from './usePresenceCamera';
import { useKioskLayout } from './useKioskLayout';
import {
  flowValuesToVisitorInfo,
  purposeIdForFlow,
  shouldShowSignage,
  shouldUseCustomFlow,
} from './integration';
import type { PresenceCameraStatus } from './usePresenceCamera';
import {
  escapeHatchesFor,
  quickActionsFor,
  type EscapeHatch,
  type QuickAction,
} from './quick-actions';
import type { ReceptionAction } from '@/domain/reception/ui-contract';
import Link from 'next/link';

/** MVP では端末 ID は固定。将来 kiosk config から取得する (issue #18)。 */
const KIOSK_ID = 'kiosk-dev';

type DirDepartment = { id: string; name: string };
type DirStaff = { id: string; displayName: string; kana?: string; aliases: string[]; departmentId: string; available: boolean };
type Directory = { departments: DirDepartment[]; staff: DirStaff[] };

function matchesQuery(s: DirStaff, query: string): boolean {
  const q = query.normalize('NFKC').trim().toLowerCase();
  if (q === '') return true;
  return [s.displayName, s.kana ?? '', ...s.aliases]
    .map((v) => v.normalize('NFKC').toLowerCase())
    .some((v) => v.includes(q));
}
/** 完了・キャンセル後に待機画面へ自動復帰するまでの時間。 */
const AUTO_RESET_MS = 6000;

/**
 * 操作途中で離席した場合に、無操作のまま待機画面へ戻すまでの時間 (issue #125)。
 * 公共端末に入力途中の個人情報を残さないための上限。`?inactivityMs=` で E2E から短縮できる。
 */
const INACTIVITY_RESET_MS = 60000;
/** 端末有効性・設定変更を検知する heartbeat 間隔 (issue #30)。 */
const HEARTBEAT_INTERVAL_MS = 30000;

/** 状態別の読み上げ文言（TTS 有効時のみ） (issue #5)。idle は案内文言を使う。 */
const SPEAK_PHRASES: Partial<Record<ReceptionState, string>> = {
  calling: '担当者を呼び出しています。少々お待ちください。',
  connected: '応答がありました。まもなくお越しになります。',
  timeout: '応答がありませんでした。別の方法でお呼びすることもできます。',
  failed: '呼び出しに失敗しました。別の方法でお呼びすることもできます。',
  completed: '受付が完了しました。ありがとうございました。',
};

type Target = { type: ReceptionTargetType; id: string; label: string };
type CallOutcome = 'connected' | 'timeout' | 'failed';

type FlowData = {
  state: ReceptionState;
  purpose?: ReceptionPurposeId;
  target?: Target;
  visitor?: VisitorInfo;
  sessionId?: string;
  outcome?: CallOutcome;
  /**
   * クイックアクションで用件を先取りした場合の目的 (issue #121)。
   * START 直後に selectingPurpose で自動選択し、目的選択画面をスキップして担当/部署選択へ
   * 進めるためのヒント。担当者を呼ぶ（用件未確定）では undefined のまま通常の目的選択を出す。
   */
  pendingPurpose?: ReceptionPurposeId;
};

type Action =
  | { type: 'START'; pendingPurpose?: ReceptionPurposeId }
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
  | { type: 'CANCEL' }
  | { type: 'RESET' };

const INITIAL: FlowData = { state: 'idle' };

function reducer(data: FlowData, action: Action): FlowData {
  const next = transition(data.state, action.type as ReceptionEvent);
  // 不正遷移は無視して現状維持（受付画面を壊さない）。
  if (next === null) return data;

  switch (action.type) {
    case 'START':
      // クイックアクションで用件を先取りした目的を保持し、selectingPurpose で自動選択する。
      return { ...data, state: next, pendingPurpose: action.pendingPurpose };
    case 'SELECT_PURPOSE':
      // 目的が確定したら先取りヒントは消費済み。target も作り直す。
      return { ...data, state: next, purpose: action.purpose, target: undefined, pendingPurpose: undefined };
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
  const [directory, setDirectory] = useState<Directory>({ departments: [], staff: [] });
  const [guidanceIdle, setGuidanceIdle] = useState('ようこそ。画面にタッチして受付を開始してください。');
  const [speakSettings, setSpeakSettings] = useState<SpeakSettings>({ ttsEnabled: false, rate: 1, volume: 1, language: 'ja-JP' });
  const [sttEnabled, setSttEnabled] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | undefined>(undefined);
  const [vrmUrl, setVrmUrl] = useState<string | undefined>(undefined);
  const [avatarFallbackUrl, setAvatarFallbackUrl] = useState<string | undefined>(undefined);
  // 状態別モーション URL（#31）。default URL に fallback して VRM レンダラへ渡す。
  const [motions, setMotions] = useState<{ motions: Partial<Record<MotionKey, string>>; defaultUrl?: string }>({
    motions: {},
  });
  // null=取得前/取得失敗（既定で表示継続）、false=失効、true=有効。
  const [active, setActive] = useState<boolean | null>(null);
  // PIN 許可状態。既定では PIN 不要として表示を継続する (issue #23)。
  const [needsAuthorize, setNeedsAuthorize] = useState(false);
  // オンライン状態。heartbeat 失敗で false、復帰で true (issue #30)。
  const [online, setOnline] = useState(true);
  // 受付モード。idle から「QRで受付」を選ぶと checkin へ。完了/通常受付選択で normal へ戻す (issue #98)。
  const [mode, setMode] = useState<'normal' | 'checkin'>('normal');

  // カスタム受付フロー (issue #100)。null=取得前/失敗、[]=無効（既定フローへフォールバック）。
  const [customFlows, setCustomFlows] = useState<KioskCustomFlow[] | null>(null);
  // 来訪者が目的選択で選んだカスタムフロー。null のときは既定フローのまま進む。
  const [selectedFlow, setSelectedFlow] = useState<KioskCustomFlow | null>(null);
  // 待機サイネージ (issue #101)。再生可能項目数だけ保持し、idle 中の待機表示判定に使う。
  const [signageCount, setSignageCount] = useState(0);
  // 来訪者検知カメラの有効化トグル (issue #79)。既定 OFF（タップ起動が常に生きる）。
  const [presenceEnabled, setPresenceEnabled] = useState(false);

  const refreshHeartbeat = useCallback(async () => {
    try {
      const res = await fetch(`/api/kiosk/heartbeat?kioskId=${encodeURIComponent(KIOSK_ID)}`, { cache: 'no-store' });
      if (!res.ok) {
        setOnline(false);
        return;
      }
      const hb = (await res.json()) as { active: boolean; pinRequired: boolean; authorized: boolean };
      setOnline(true);
      setActive(hb.active);
      setNeedsAuthorize(hb.pinRequired && !hb.authorized);
      // 失効/緊急停止を検知したら、受付中の個人情報を破棄して待機へ戻す (issue #30)。
      if (!hb.active) {
        dispatch({ type: 'RESET' });
        setMode('normal');
      }
    } catch {
      setOnline(false);
    }
  }, []);

  // 起動時に確認し、以降は定期 heartbeat で長期表示中の変化を検知する (issue #30)。
  useEffect(() => {
    void refreshHeartbeat();
    const timer = setInterval(() => void refreshHeartbeat(), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshHeartbeat]);

  // 部署・担当者を管理画面と共有のディレクトリ API から取得する (issue #3)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/directory');
        if (!res.ok) return;
        const dir = (await res.json()) as Directory;
        if (!cancelled) setDirectory(dir);
      } catch {
        /* 取得失敗時は空のまま。受付開始ボタンは表示され、画面は壊れない */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 音声設定の案内文言を受付画面へ反映する (issue #28)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/voice');
        if (!res.ok) return;
        const voice = (await res.json()) as {
          guidanceIdle?: string;
          ttsEnabled?: boolean;
          sttEnabled?: boolean;
          rate?: number;
          volume?: number;
          language?: string;
        };
        if (cancelled) return;
        if (voice.guidanceIdle) setGuidanceIdle(voice.guidanceIdle);
        setSttEnabled(voice.sttEnabled ?? false);
        setSpeakSettings({
          ttsEnabled: voice.ttsEnabled ?? false,
          rate: voice.rate ?? 1,
          volume: voice.volume ?? 1,
          language: voice.language ?? 'ja-JP',
        });
      } catch {
        /* 取得失敗時は既定文言を使う */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 適用中の背景アセットを反映する (issue #27)。読み込み失敗時は背景色で fallback。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/assets');
        if (!res.ok) return;
        const assets = (await res.json()) as { backgroundUrl?: string; vrmUrl?: string; fallbackImageUrl?: string };
        if (cancelled) return;
        setBackgroundUrl(assets.backgroundUrl);
        setVrmUrl(assets.vrmUrl);
        setAvatarFallbackUrl(assets.fallbackImageUrl);
      } catch {
        /* 取得失敗時は既定背景 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 状態別モーション URL を取得する (issue #31)。未設定/失敗時は default または無効化で fallback。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/motions');
        if (!res.ok) return;
        const m = (await res.json()) as { motions: Partial<Record<MotionKey, string>>; defaultUrl?: string };
        if (!cancelled) setMotions({ motions: m.motions ?? {}, defaultUrl: m.defaultUrl });
      } catch {
        /* 取得失敗時はモーション無し（アバターは静止/ fallback のまま） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 有効なカスタム受付フローを取得する (issue #100)。取得失敗/無効時は既定フローへフォールバック。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/flow', { cache: 'no-store' });
        if (!res.ok) {
          // 403（セッション未確立）/503（障害）等は既定フローで継続する。
          if (!cancelled) setCustomFlows([]);
          return;
        }
        const body = (await res.json()) as { flows?: KioskCustomFlow[] };
        if (!cancelled) setCustomFlows(body.flows ?? []);
      } catch {
        if (!cancelled) setCustomFlows([]); // 取得失敗＝既定フロー
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 待機サイネージの再生可能項目数を取得する (issue #101)。失敗/無効時は 0（既定 IdleView）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/signage');
        if (!res.ok) return;
        const sig = (await res.json()) as { items?: unknown[] };
        if (!cancelled) setSignageCount(Array.isArray(sig.items) ? sig.items.length : 0);
      } catch {
        /* 取得失敗時は 0 のまま（待機画面は既定の IdleView） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Vonage（非同期）通話のとき、ビデオビューに渡す受付 ID。Mock 同期通話では null のまま。
  const [vonageCallId, setVonageCallId] = useState<string | null>(null);

  // 呼び出し中になったら、セッション作成 → 呼び出しを実行して結果を反映する。
  useEffect(() => {
    if (data.state !== 'calling') return;
    let cancelled = false;
    setVonageCallId(null);

    (async () => {
      try {
        const createRes = await fetch('/api/kiosk/receptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kioskId: KIOSK_ID,
            purpose: data.purpose,
            // カスタムフロー選択時は purposeKey も併送する（サーバ将来拡張用・未知でも非破壊）(issue #100)。
            purposeKey: selectedFlow?.purposeKey,
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
        // 'calling' は Vonage（非同期）: ビデオビューが応答/未応答を確定する。
        else if (result.state === 'calling') setVonageCallId(session.id);
        else dispatch({ type: 'CALL_FAILED', sessionId: session.id });
      } catch {
        if (!cancelled) dispatch({ type: 'CALL_FAILED' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data.state, data.purpose, data.target, data.visitor, selectedFlow]);

  // 完了・キャンセル後は一定時間で待機画面へ自動復帰する。個人情報も破棄される。
  useEffect(() => {
    if (data.state !== 'completed' && data.state !== 'cancelled') return;
    const timer = setTimeout(() => dispatch({ type: 'RESET' }), AUTO_RESET_MS);
    return () => clearTimeout(timer);
  }, [data.state]);

  // 操作途中（選択・入力・確認・結果案内）で離席した場合、無操作のまま一定時間で待機へ戻す
  // (issue #125)。RESET は INITIAL を返すため、入力済みの氏名等 PII は持ち越されない。
  // 来訪者がタッチ/キー操作するたびにタイマーを延長する。
  useEffect(() => {
    if (!shouldResetOnInactivity(data.state)) return;
    const params = new URLSearchParams(window.location.search);
    const override = Number(params.get('inactivityMs'));
    const limit = Number.isFinite(override) && override > 0 ? override : INACTIVITY_RESET_MS;
    let timer = window.setTimeout(() => dispatch({ type: 'RESET' }), limit);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => dispatch({ type: 'RESET' }), limit);
    };
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
    };
  }, [data.state]);

  // idle へ戻ったら選んだカスタムフローを破棄する（次の来訪者へ持ち越さない）(issue #100)。
  useEffect(() => {
    if (data.state === 'idle') setSelectedFlow(null);
  }, [data.state]);

  // 音声合成が有効な場合、状態に応じた案内を読み上げる (issue #5)。
  useEffect(() => {
    const phrase = SPEAK_PHRASES[data.state] ?? (data.state === 'idle' ? guidanceIdle : undefined);
    if (phrase) speak(phrase, speakSettings);
  }, [data.state, guidanceIdle, speakSettings]);

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

  const handleFallback = useCallback(async () => {
    if (data.sessionId) {
      try {
        await fetch(`/api/kiosk/receptions/${data.sessionId}/fallback`, { method: 'POST' });
      } catch {
        /* 代替導線の記録失敗は受付フローを止めない */
      }
    }
    dispatch({ type: 'USE_FALLBACK' });
  }, [data.sessionId]);

  // 担当者の応答アクションを短時間ポーリングで取得する (issue #99)。
  // 呼び出し中・応答後（calling/connected）のみ。終端状態では停止し、個人情報は持ち越さない。
  const pollResponseEnabled = data.state === 'calling' || data.state === 'connected';
  const staffResponse = useStaffResponse(data.sessionId ?? null, { enabled: pollResponseEnabled });

  // 拒否・別チャネル誘導（offersFallback）応答からの代替導線。calling からは USE_FALLBACK が
  // 不正遷移のため、まず failed へ落としてから既存の代替導線フロー（ResultView）へ繋ぐ。
  const handleStaffResponseFallback = useCallback(() => {
    if (data.state === 'calling') {
      dispatch({ type: 'CALL_FAILED', sessionId: data.sessionId });
    } else {
      void handleFallback();
    }
  }, [data.state, data.sessionId, handleFallback]);

  // 受付開始（タップ / サイネージ / 来訪検知 共通）。音声再生を有効化してから START。
  const startReception = useCallback(() => {
    primeSpeech();
    dispatch({ type: 'START' });
  }, []);

  // クイックアクションからの受付開始 (issue #121)。用件を先取りした目的を pendingPurpose に載せる。
  // checkin（QR 受付）はモード切替なので START を使わず、ここではなく UI 側で mode='checkin' にする。
  const startWithQuickAction = useCallback((action: QuickAction) => {
    if (action.isCheckin) {
      setMode('checkin');
      return;
    }
    primeSpeech();
    dispatch({ type: 'START', pendingPurpose: action.presetPurpose });
  }, []);

  // 用件先取りがあるとき、目的選択画面をスキップして担当/部署選択へ自動で進める (issue #121)。
  // カスタムフロー有効時はカスタム目的選択を尊重するためスキップしない。
  useEffect(() => {
    if (data.state !== 'selectingPurpose') return;
    if (!data.pendingPurpose) return;
    if (shouldUseCustomFlow(customFlows)) return;
    dispatch({ type: 'SELECT_PURPOSE', purpose: data.pendingPurpose });
  }, [data.state, data.pendingPurpose, customFlows]);

  const view = active === false ? 'revoked' : needsAuthorize ? 'authorize' : 'ready';

  // 待機サイネージを出すか (issue #101)。idle・online・非失効・項目ありのときだけ。
  const showSignage = shouldShowSignage({
    receptionState: data.state,
    online,
    active,
    signageItemCount: signageCount,
  });
  // カスタムフローを使うか (issue #100)。無効/未取得は既定フローへフォールバック。
  const useCustomFlow = shouldUseCustomFlow(customFlows);

  // 来訪者検知カメラ (issue #79)。待機サイネージ表示中かつトグル ON のときだけ起動。
  // 未対応/拒否時は status='unavailable' に倒れ、タップ起動で完走する（非破壊）。
  const presenceActive = presenceEnabled && showSignage && mode === 'normal' && view === 'ready';
  const presence = usePresenceCamera(presenceActive, startReception);

  // 現在の受付状態に対応するモーション URL（未設定は default に fallback）(issue #31)。
  const motionUrl = resolveMotionUrl(motionKeyForState(data.state), motions.motions, motions.defaultUrl);

  // 画面種別（iPad 縦/横・4K/大型）のレイアウトプロファイル (issue #124)。
  // 配置は CSS が data-kiosk-layout 属性で切り替える。
  const layout = useKioskLayout();

  const backgroundStyle: React.CSSProperties = backgroundUrl
    ? { backgroundImage: `url(${backgroundUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {};

  return (
    <main
      className="screen"
      data-kiosk-state={view === 'ready' ? data.state : view}
      // 受付状態に対応するモーションキー。VRM レンダラ（#5）が消費する (issue #31)。
      data-kiosk-motion={motionKeyForState(data.state)}
      // 画面種別レイアウトプロファイル。配置は CSS が消費する (issue #124)。
      data-kiosk-layout={layout}
      style={backgroundStyle}
    >
      {!online ? (
        <div className="notice notice--warning" data-testid="kiosk-offline" style={{ marginBottom: 'var(--space-md)' }}>
          通信が不安定です。復帰までしばらくお待ちください。
        </div>
      ) : null}
      {view === 'revoked' ? (
        <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <div className="notice notice--danger" data-testid="kiosk-revoked">
            この受付端末は現在ご利用いただけません。担当者にお問い合わせください。
          </div>
        </div>
      ) : view === 'authorize' ? (
        <KioskAuthorizeView onAuthorized={() => setNeedsAuthorize(false)} />
      ) : mode === 'checkin' ? (
        // QR 受付モード (issue #98)。通常受付選択 / 終了で normal へ戻す（個人情報は破棄される）。
        <CheckinFlow onUseManual={() => setMode('normal')} onExit={() => setMode('normal')} />
      ) : showSignage ? (
        // 待機サイネージ (issue #101) + 来訪検知 (issue #79)。タップ/検知/QR/退館で受付へ。
        <SignageWaitingView
          onStart={startReception}
          onStartCheckin={() => setMode('checkin')}
          presenceEnabled={presenceEnabled}
          onTogglePresence={() => setPresenceEnabled((v) => !v)}
          presenceStatus={presence.status}
        />
      ) : useCustomFlow && data.state === 'selectingPurpose' ? (
        // カスタム目的選択 (issue #100)。選択でフローを保持し、入力ステップ有無で次へ分岐。
        <CustomPurposeView
          flows={customFlows ?? []}
          onCancel={() => dispatch({ type: 'RESET' })}
          onSelect={(flow) => {
            setSelectedFlow(flow);
            dispatch({ type: 'SELECT_PURPOSE', purpose: purposeIdForFlow(flow) });
          }}
        />
      ) : useCustomFlow && selectedFlow && data.state === 'inputVisitorInfo' ? (
        // カスタム来訪者情報入力 (issue #100)。確認・呼び出しは既存状態機械へ委譲。
        <CustomVisitorInfoView
          flow={selectedFlow}
          onBack={() => dispatch({ type: 'BACK' })}
          onSubmit={(values) =>
            dispatch({ type: 'SUBMIT_VISITOR_INFO', visitor: flowValuesToVisitorInfo(selectedFlow, values) })
          }
        />
      ) : (
        <>
          {renderScreen(
            data,
            dispatch,
            complete,
            handleFallback,
            directory,
            guidanceIdle,
            vrmUrl,
            avatarFallbackUrl,
            sttEnabled,
            motionUrl,
            vonageCallId,
            () => setMode('checkin'),
            staffResponse,
            handleStaffResponseFallback,
            startWithQuickAction,
          )}
          {/* 退館チェックアウト導線 (issue #102)。待機中のみ小さく常設する（非破壊）。 */}
          {data.state === 'idle' ? <CheckoutLink /> : null}
          {/*
            常時見える「逃げ道」バー (issue #121)。状態に応じて 戻る/キャンセル/最初に戻る/人に繋ぐ を
            表示する。出すアクションは #120 契約の availableActions に従う（許可外は出さない）。
            各画面の文脈ボタン（修正する等）とは別に、画面下部に安全な離脱導線を常設する。
          */}
          <EscapeHatchBar
            state={data.state}
            onAction={(action) => {
              // useFallback は記録 API を伴うため専用ハンドラへ。残りは状態機械イベントへ写す。
              if (action === 'useFallback') {
                void handleFallback();
                return;
              }
              // escapeHatchesFor が返すのは back/cancel/reset/useFallback のみ（useFallback は上で処理）。
              const eventByAction: Partial<Record<ReceptionAction, Action>> = {
                back: { type: 'BACK' },
                cancel: { type: 'CANCEL' },
                reset: { type: 'RESET' },
              };
              const next = eventByAction[action];
              if (next) dispatch(next);
            }}
          />
          {/*
            #122 Chat-assisted ドロワーのマウントポイント。中身は後続トラックが差し込む。
            開閉/利用可否は deriveChatAvailability(state) を購読して制御する想定（idle/終端では閉じる）。
          */}
          <div className="kiosk-chat-slot" data-slot="chat-drawer" aria-hidden="true" />
        </>
      )}
    </main>
  );
}

/**
 * 常時見える逃げ道バー (issue #121)。
 *
 * `escapeHatchesFor(state)`（#120 契約の availableActions 由来）が返すアクションだけを出す。
 * idle や逃げ道が無い状態では何も描画しない。重要操作（確認必須）は含めない。
 */
function EscapeHatchBar({
  state,
  onAction,
}: {
  state: ReceptionState;
  onAction: (action: ReceptionAction) => void;
}) {
  const hatches: ReadonlyArray<EscapeHatch> = escapeHatchesFor(state);
  if (hatches.length === 0) return null;
  return (
    <nav
      className="kiosk-escape-bar"
      data-testid="kiosk-escape-bar"
      aria-label="受付の操作（戻る・キャンセルなど）"
    >
      {hatches.map((hatch) => (
        <button
          key={hatch.action}
          type="button"
          className={`btn btn--${hatch.variant}`}
          data-testid={hatch.testId}
          onClick={() => onAction(hatch.action)}
        >
          {hatch.label}
        </button>
      ))}
    </nav>
  );
}

function KioskAuthorizeView({ onAuthorized }: { onAuthorized: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch('/api/kiosk/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, kioskId: KIOSK_ID }),
      });
      if (res.ok) onAuthorized();
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="screen__body"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 'var(--space-lg)' }}
    >
      <h1 className="screen__title">受付端末の許可</h1>
      <p className="screen__lead">PIN を入力してください。</p>
      <input
        type="password"
        inputMode="numeric"
        className="input"
        data-testid="kiosk-pin"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        style={{ maxWidth: 280, textAlign: 'center' }}
      />
      {error ? (
        <p className="notice notice--danger" data-testid="kiosk-pin-error">
          PIN が正しくありません。
        </p>
      ) : null}
      <button type="submit" className="btn btn--primary" data-testid="kiosk-authorize" disabled={busy}>
        受付を開始する
      </button>
    </form>
  );
}

/**
 * 待機サイネージ + 来訪検知の待機画面 (issue #101 / #79 統合)。
 *
 * 埋め込み版 SignageDisplay（onStart で受付状態機械の START を呼ぶ）に、来訪検知トグルと
 * 受付/QR/退館の明示導線を重ねる。受付開始導線は常に大きく表示する（issue #101 UX 方針）。
 * カメラはトグル ON のときだけ起動し、未対応/拒否（unavailable）でもタップ起動で完走する。
 */
function SignageWaitingView({
  onStart,
  onStartCheckin,
  presenceEnabled,
  onTogglePresence,
  presenceStatus,
}: {
  onStart: () => void;
  onStartCheckin: () => void;
  presenceEnabled: boolean;
  onTogglePresence: () => void;
  presenceStatus: PresenceCameraStatus;
}) {
  return (
    <div data-testid="kiosk-signage-waiting" style={{ position: 'relative', minHeight: '100%' }}>
      <SignageDisplay onStart={onStart} />
      <div
        className="screen__footer"
        style={{ position: 'absolute', bottom: 'var(--space-md)', left: 0, right: 0, justifyContent: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}
      >
        <button type="button" className="btn btn--secondary" data-testid="signage-start-checkin" onClick={onStartCheckin}>
          QR で受付
        </button>
        <CheckoutLink />
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="presence-toggle"
          aria-pressed={presenceEnabled}
          onClick={onTogglePresence}
        >
          {presenceEnabled
            ? presenceStatus === 'unavailable'
              ? '来訪検知: 利用不可'
              : '来訪検知: ON'
            : '来訪検知: OFF'}
        </button>
      </div>
    </div>
  );
}

/** 退館チェックアウトへの明示導線 (issue #102)。/kiosk/checkout へ遷移する小ボタン。 */
function CheckoutLink() {
  return (
    <Link href="/kiosk/checkout" className="btn btn--ghost" data-testid="kiosk-checkout-link">
      退館チェックアウト
    </Link>
  );
}

/** カスタム目的選択画面 (issue #100)。スタンドアロン PurposeSelector を受付画面の枠で包む。 */
function CustomPurposeView({
  flows,
  onSelect,
  onCancel,
}: {
  flows: readonly KioskCustomFlow[];
  onSelect: (flow: KioskCustomFlow) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="screen__body" data-testid="custom-purpose-view">
        <PurposeSelector flows={flows} onSelect={onSelect} />
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="purpose-cancel" onClick={onCancel}>
          最初に戻る
        </button>
      </div>
    </>
  );
}

/** カスタム来訪者情報入力画面 (issue #100)。fields が無ければ入力を省略して確認へ進める。 */
function CustomVisitorInfoView({
  flow,
  onSubmit,
  onBack,
}: {
  flow: KioskCustomFlow;
  onSubmit: (values: FlowFieldValues) => void;
  onBack: () => void;
}) {
  // visitorInfo ステップが無い / fields 空のフローは、入力なしで確認へ進める（非破壊）。
  if (!flow.steps.includes('visitorInfo') || flow.fields.length === 0) {
    return (
      <>
        <div className="screen__body" data-testid="custom-flow-no-input" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <h1 className="screen__title">{flow.displayName}</h1>
          {flow.description ? <p className="screen__lead">{flow.description}</p> : null}
        </div>
        <div className="screen__footer">
          <button type="button" className="btn btn--ghost" data-testid="visitor-back" onClick={onBack}>
            戻る
          </button>
          <button type="button" className="btn btn--primary" data-testid="custom-flow-proceed" onClick={() => onSubmit({})}>
            確認へ進む
          </button>
        </div>
      </>
    );
  }
  return (
    <div className="screen__body" data-testid="custom-visitor-view">
      <VisitorInfoForm fields={flow.fields} onBack={onBack} onSubmit={onSubmit} />
    </div>
  );
}

function renderScreen(
  data: FlowData,
  dispatch: React.Dispatch<Action>,
  complete: () => void,
  onFallback: () => void,
  directory: Directory,
  guidanceIdle: string,
  vrmUrl: string | undefined,
  avatarFallbackUrl: string | undefined,
  sttEnabled: boolean,
  motionUrl: string | undefined,
  vonageCallId: string | null,
  onStartCheckin: () => void,
  staffResponse: StaffResponseResult | null,
  onStaffResponseFallback: () => void,
  onQuickAction: (action: QuickAction) => void,
) {
  switch (data.state) {
    case 'idle':
      return (
        <IdleView
          onQuickAction={onQuickAction}
          guidance={guidanceIdle}
          vrmUrl={vrmUrl}
          avatarFallbackUrl={avatarFallbackUrl}
          motionUrl={motionUrl}
        />
      );
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
          directory={directory}
          sttEnabled={sttEnabled}
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
      // Vonage（非同期）通話はビデオビューがライフサイクルを駆動する。Mock 同期通話は従来表示。
      // 担当者の応答アクションがあれば、その来訪者向けメッセージを上に重ねて表示する (issue #99)。
      return (
        <>
          <StaffResponseBanner response={staffResponse} onFallback={onStaffResponseFallback} />
          {vonageCallId ? (
            <KioskCallView
              receptionId={vonageCallId}
              onConnected={() => dispatch({ type: 'CALL_CONNECTED', sessionId: vonageCallId })}
              onTimeout={() => dispatch({ type: 'CALL_TIMEOUT', sessionId: vonageCallId })}
              onFallback={() => dispatch({ type: 'CALL_FAILED', sessionId: vonageCallId })}
            />
          ) : (
            <CallingView target={data.target?.label ?? ''} />
          )}
        </>
      );
    case 'connected':
      return (
        <>
          <StaffResponseBanner response={staffResponse} onFallback={onStaffResponseFallback} />
          <ConnectedView target={data.target?.label ?? ''} onComplete={complete} />
        </>
      );
    case 'timeout':
    case 'failed':
      return (
        <ResultView
          outcome={data.state}
          onFallback={onFallback}
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

/**
 * 待機/初期画面 (issue #121 タッチファースト再設計)。
 *
 * 1 画面 1 主目的: 「何のご用件か」を大きなカードで選ぶ。主要 CTA（担当者を呼ぶ / QR で受付 /
 * 部署から選ぶ / 配送・納品 / その他）はクイックアクションとして `quickActionsFor('idle')` から
 * 描画する（ボタン集合の真実源は #120 の契約）。音声・チャットなしでもタッチだけで進める。
 *
 * 後方互換: 既存 E2E/テストが参照する `start-reception`（受付を開始する）と
 * `start-checkin`（QR で受付）の testid を、それぞれ「担当者を呼ぶ」「QR で受付」カードに
 * 付与し直して維持する。
 */
function IdleView({
  onQuickAction,
  guidance,
  vrmUrl,
  avatarFallbackUrl,
  motionUrl,
}: {
  onQuickAction: (action: QuickAction) => void;
  guidance: string;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  motionUrl?: string;
}) {
  const actions = quickActionsFor('idle');
  // 既存 testid との後方互換（再設計後もリンク切れにしない）。
  const legacyTestId: Partial<Record<QuickAction['intent'], string>> = {
    callStaff: 'start-reception',
    checkin: 'start-checkin',
  };
  return (
    <div className="screen__body kiosk-idle" data-testid="kiosk-idle">
      {/* #123 アバター状態同期のマウントポイント。発話/字幕は後続トラックが差し込む。 */}
      <div className="kiosk-idle__avatar" data-slot="avatar">
        <VrmAvatarViewer
          vrmUrl={vrmUrl}
          fallbackImageUrl={avatarFallbackUrl}
          motionUrl={motionUrl}
          className="kiosk-avatar"
        />
      </div>
      <header className="kiosk-idle__head">
        <h1 className="screen__title">ご用件をお選びください</h1>
        <p className="screen__lead" data-testid="idle-guidance">
          {guidance}
        </p>
      </header>
      <div className="card-grid kiosk-quick-actions" data-testid="kiosk-quick-actions">
        {actions.map((action) => (
          <button
            key={action.intent}
            type="button"
            className="card card--cta"
            data-testid={legacyTestId[action.intent] ?? action.testId}
            data-intent={action.intent}
            onClick={() => onQuickAction(action)}
          >
            {action.label}
            <span className="card__sub">{action.description}</span>
          </button>
        ))}
      </div>
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

function TargetView({
  directory,
  sttEnabled,
  onSelect,
  onBack,
}: {
  directory: Directory;
  sttEnabled: boolean;
  onSelect: (t: Target) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  // 音声認識の候補。タップで検索欄に反映し、来訪者の確認後に選択する（即時呼び出ししない）(issue #5)。
  const [sttCandidates, setSttCandidates] = useState<string[]>([]);
  const [sttListening, setSttListening] = useState(false);
  const results = useMemo(() => directory.staff.filter((s) => matchesQuery(s, query)), [directory.staff, query]);
  const departments = directory.departments;

  const listen = useCallback(async () => {
    if (sttListening) return;
    setSttListening(true);
    try {
      // 実ブラウザの音声認識は実機前提（#65）。ここでは在席担当者名から候補を生成する。
      const phrases = directory.staff
        .filter((s) => s.available)
        .map((s) => s.kana ?? s.displayName);
      const candidates = await new MockSttAdapter(phrases).listen();
      setSttCandidates(candidates);
    } finally {
      setSttListening(false);
    }
  }, [directory.staff, sttListening]);

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

        {sttEnabled ? (
          <div className="field" data-testid="stt-panel">
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="stt-listen"
              onClick={() => void listen()}
              disabled={sttListening}
            >
              {sttListening ? '聞き取り中…' : '音声で担当者を探す'}
            </button>
            {sttCandidates.length > 0 ? (
              <>
                <p className="card__sub" data-testid="stt-hint">
                  認識した候補です。タップして検索欄に反映し、内容をご確認のうえお選びください。
                </p>
                <div className="card-grid" data-testid="stt-candidates">
                  {sttCandidates.map((c, i) => (
                    <button
                      key={`${c}-${i}`}
                      type="button"
                      className="card"
                      data-testid={`stt-candidate-${i}`}
                      // 候補は検索欄に反映するのみ。担当者選択・呼び出しは行わない (issue #5)。
                      onClick={() => setQuery(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className="card-grid">
            {results.map((s) =>
              s.available ? (
                <button
                  key={s.id}
                  type="button"
                  className="card"
                  data-testid={`staff-${s.id}`}
                  onClick={() => onSelect({ type: 'staff', id: s.id, label: s.displayName })}
                >
                  {s.displayName}
                  <span className="card__sub">{directory.departments.find((d) => d.id === s.departmentId)?.name}</span>
                </button>
              ) : (
                // 不在の担当者は呼び出せない。部署/代表窓口へ誘導する (issue #26)。
                <div
                  key={s.id}
                  className="card"
                  data-testid={`staff-${s.id}`}
                  data-unavailable="true"
                  aria-disabled="true"
                  style={{ opacity: 0.55, cursor: 'not-allowed' }}
                >
                  {s.displayName}
                  <span className="card__sub" data-testid={`staff-${s.id}-absent`}>
                    現在不在です。部署または代表窓口をお選びください。
                  </span>
                </div>
              ),
            )}
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

/**
 * 担当者の応答アクションを来訪者向けに表示するバナー (issue #99)。
 * 応答がなければ何も描画しない（呼び出し中の通常表示を妨げない）。
 * 拒否・別チャネル誘導（offersFallback）のときは代替導線を併記する。
 */
function StaffResponseBanner({
  response,
  onFallback,
}: {
  response: StaffResponseResult | null;
  onFallback: () => void;
}) {
  if (!response) return null;
  const noticeClass =
    response.severity === 'danger'
      ? 'notice notice--danger'
      : response.severity === 'warning'
        ? 'notice notice--warning'
        : response.severity === 'success'
          ? 'notice notice--success'
          : 'notice';
  return (
    <div
      className="staff-response-banner"
      data-testid="staff-response-banner"
      data-status={response.kioskStatus}
      style={{ marginBottom: 'var(--space-md)' }}
    >
      <div className={noticeClass} role="status" data-testid="staff-response-message">
        {response.visitorMessage}
      </div>
      {response.offersFallback ? (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="staff-response-fallback"
          onClick={onFallback}
          style={{ marginTop: 'var(--space-sm)' }}
        >
          受付窓口へ
        </button>
      ) : null}
    </div>
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
