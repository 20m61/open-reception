'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  RECEPTION_PURPOSES,
  type ReceptionPurposeId,
  type ReceptionTargetType,
  type VisitorInfo,
} from '@/domain/reception/session';
import type { FeedbackReasonCode, SatisfactionRating } from '@/domain/reception/log';
import {
  shouldResetOnInactivity,
  transition,
  type ReceptionEvent,
  type ReceptionState,
} from '@/domain/reception/state';
import { motionKeyForState, resolveMotionUrl, type MotionKey } from '@/domain/motion/types';
import { primeSpeech, speak, type SpeakSettings } from './speech';
import { AvatarGuide } from './avatar/AvatarGuide';
import type { AvatarGuidanceOverride } from './avatar/guidance';
import { LanguageSwitcher } from './LanguageSwitcher';
import { makeT, DEFAULT_LOCALE, htmlLangFor, type Locale, type MessageKey } from '@/lib/i18n';
import { LOCALE_LANGUAGE_CODE } from '@/lib/voice/locale-voice';
import { AccessibilityMenu } from './AccessibilityMenu';
import {
  DEFAULT_A11Y_MODE_STATE,
  clampA11yModeState,
  sanitizeA11yEnabledModes,
  type A11yEnabledModes,
  type FontScale,
} from '@/domain/kiosk/a11y-modes';
import { FlowStepper } from './FlowStepper';
import { quickActionIcon, purposeIcon } from './quick-action-icons';
import { hasBrandingContent, normalizeAccentColor, type BrandingSettings } from '@/domain/branding/types';
import { resultToneForState, type ResultTone } from './result-tone';
import { resolvePrivacyNoticeContent } from './privacy-notice';
import type { QuickActionIntent } from './quick-actions';
import dynamic from 'next/dynamic';
import { KioskCallView } from './KioskCallView';

/**
 * チェックイン画面は QR デコーダ（jsQR）とカメラスキャナを内包するため `next/dynamic` で
 * kiosk 初期チャンクから分離する (#196)。checkin モードへ遷移したときのみ読み込む。
 * ssr:false（カメラ前提のクライアント専用）。ローディング中は null（従来もカメラ起動までは
 * 実表示が無く、E2E は要素の出現を待つため影響しない）。
 */
const CheckinFlow = dynamic(() => import('./CheckinFlow').then((mod) => mod.CheckinFlow), {
  ssr: false,
  loading: () => null,
});
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
  resolveKioskGate,
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
import { deriveChatAvailability, type ReceptionAction } from '@/domain/reception/ui-contract';
import { KioskChatDrawer } from './KioskChatDrawer';
import { buildCheckoutUrl, safeCheckoutQrDataUrl } from './checkout/credential-display';
import Link from 'next/link';
import {
  createTracker,
  enterStep,
  finalizeExperience,
  recordBack,
  recordCancel,
  recordInputMethod,
  recordSearchQuery,
  stepForState,
  type ExperienceTracker,
} from '@/domain/reception/experience-metrics';
import { EXPERIENCE_STEP_ORDER } from '@/domain/reception/experience-summary';
import { searchStaffScored } from '@/domain/staff/search';
import {
  clampCallingStageThresholds,
  deriveCallingStage,
  timeoutDispatchDelayMs,
  type CallingStage,
  type CallingStageThresholds,
} from '@/domain/reception/calling-experience';

/**
 * MVP では heartbeat・PIN 許可（初回セッション発行前）向けの端末 ID は固定。将来 kiosk
 * config から取得する (issue #18)。
 *
 * 受付作成（`POST /api/kiosk/receptions`）はこの定数を送らない (issue #348):
 * `reception.kioskId` はサーバが認証済み kiosk セッション（cookie）から確定するため、
 * クライアントがここで何を送っても（送らなくても）権威にならない。かつてこの定数を
 * 受付作成にも使い回していたため、実際にエンロールされた端末（ランダム UUID の
 * kioskId）と 'kiosk-dev' 固定値が食い違い、以後の所有権チェック（status/stay）が
 * 正当な同一端末の要求まで 403 にしていた。
 */
const KIOSK_ID = 'kiosk-dev';

type DirDepartment = { id: string; name: string };
type DirStaff = { id: string; displayName: string; kana?: string; aliases: string[]; departmentId: string; available: boolean };
type Directory = { departments: DirDepartment[]; staff: DirStaff[] };
/** 完了・キャンセル後に待機画面へ自動復帰するまでの時間。 */
const AUTO_RESET_MS = 6000;

/**
 * 操作途中で離席した場合に、無操作のまま待機画面へ戻すまでの時間 (issue #125)。
 * 公共端末に入力途中の個人情報を残さないための上限。`?inactivityMs=` で E2E から短縮できる。
 */
const INACTIVITY_RESET_MS = 60000;
/**
 * connected（担当者応答済み・来訪待ち）画面の無操作リセット上限 (#324)。
 * 「操作は不要です」と案内し来訪者はその場で担当者の到着を待つため、選択/入力画面より長めに取り、
 * 正当な待機中の誤リセットを避ける。離席した場合はこの時間で PII を破棄して待機へ戻す。
 * 待機中の来訪者は警告カウントダウンで「続ける」を押せば延長できる。
 */
const CONNECTED_INACTIVITY_RESET_MS = 120000;
/**
 * リセット前にカウントダウン警告を出す時間 (issue #125 UX, "don't surprise-expire")。
 * 残り WARNING ミリ秒で警告を表示し、来訪者が操作すれば延長する。
 */
const INACTIVITY_WARNING_MS = 10000;
/** 端末有効性・設定変更を検知する heartbeat 間隔 (issue #30)。 */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * アバター常設コンパニオン（#123）を表示する状態。中央寄せで余白のあるステータス画面に限定し、
 * 選択/入力画面（カード・フォームでコンテンツが密集）では重なりを避けて出さない。
 */
const AVATAR_COMPANION_STATES: ReadonlySet<ReceptionState> = new Set([
  'calling',
  'connected',
  'timeout',
  'failed',
  'fallback',
  'completed',
  'cancelled',
]);

function showAvatarCompanion(state: ReceptionState): boolean {
  return AVATAR_COMPANION_STATES.has(state);
}

/** 「動いている」演出のための定期更新の上限間隔（ms）。段階境界が近ければもっと短く刻む。 */
const CALLING_TICK_MAX_MS = 500;

/**
 * 呼び出し中(calling)の経過段階を UI 層のタイマーで導出するフック (issue #323)。
 *
 * 「動いている」ことの伝達を優先し、正確な秒数カウントより段階（dialing/waiting/
 * preTimeoutNotice）の切り替えを重視する。次の tick は「段階の境界（waitingAfterMs /
 * noticeAfterMs）」または `CALLING_TICK_MAX_MS` のどちらか近い方に合わせて動的に予約する
 * （固定間隔だと、E2E のようにしきい値を短く上書きしたときに境界を読み飛ばしうるため）。
 *
 * `startedAtRef` は calling に入った時刻（ms epoch）を持つ ref（レンダー中に ref を直接
 * 読まないよう、`.current` の読み出しは常にタイマーコールバック内で行い、結果は state に
 * 反映する）。`active=false` の間はタイマーを止め 'dialing'・経過 0 を返す。
 *
 * state.ts の遷移表・ui-contract.ts の screenState/avatarState 写像は一切変更しない
 * （ここで導出する段階は KioskFlow ローカルの見た目の演出のみ）。
 */
function useCallingStage(
  active: boolean,
  startedAtRef: React.RefObject<number | null>,
  thresholds: CallingStageThresholds,
): { stage: CallingStage; elapsedMs: number } {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsedMs(0);
      return;
    }
    let timer = 0;
    const tick = () => {
      const startedAt = startedAtRef.current;
      const elapsed = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
      setElapsedMs(elapsed);
      // 次に到達すべき段階境界までの残り時間（無ければ上限間隔で「動いている」演出だけ更新する）。
      const nextBoundaryMs =
        elapsed < thresholds.waitingAfterMs
          ? thresholds.waitingAfterMs
          : elapsed < thresholds.noticeAfterMs
            ? thresholds.noticeAfterMs
            : null;
      const untilBoundaryMs = nextBoundaryMs === null ? Infinity : Math.max(0, nextBoundaryMs - elapsed);
      // 境界のわずかに後（+10ms）まで読み、確実に境界を跨いだ状態を検知する。
      const delay = Math.min(CALLING_TICK_MAX_MS, Number.isFinite(untilBoundaryMs) ? untilBoundaryMs + 10 : CALLING_TICK_MAX_MS);
      timer = window.setTimeout(tick, delay);
    };
    tick();
    return () => window.clearTimeout(timer);
    // startedAtRef は ref オブジェクト自体（identity は不変）を依存にする。中身の変更検知は
    // tick() の中で毎回読む（react-hooks/refs: レンダー中に ref を触らない）。
  }, [active, startedAtRef, thresholds]);
  return { stage: deriveCallingStage(elapsedMs, thresholds), elapsedMs };
}

/**
 * 呼び出し中の段階（dialing/waiting/preTimeoutNotice）から表示文言を導出する (#323)。
 *
 * ja のみテナント上書き（`guidanceCallingWaiting` / `guidanceCallingNotice`。#28 の
 * 案内文言設定と同じ運用）を尊重し、他 locale は i18n 辞書の既定文言を使う（`guidanceIdle` と
 * 同じ運用方針。avatar/guidance.ts の locale 内製文言とは別に、辞書（dictionary.ts）を
 * 真実源にする＝ #327 の全 locale 網羅検証の対象にする）。dialing 段階は既存の
 * `reception.callingBody` をそのまま使い、新規表示を増やさない（既存動作を変えない）。
 */
function callingStageMessage(
  stage: CallingStage,
  target: string,
  locale: Locale,
  textOverride: { waiting?: string; notice?: string },
): string {
  const tr = makeT(locale);
  if (stage === 'waiting') {
    return locale === DEFAULT_LOCALE && textOverride.waiting
      ? textOverride.waiting
      : tr('reception.callingStageWaiting');
  }
  if (stage === 'preTimeoutNotice') {
    return locale === DEFAULT_LOCALE && textOverride.notice
      ? textOverride.notice
      : tr('reception.callingStageNotice');
  }
  return tr('reception.callingBody', { target });
}

type Target = { type: ReceptionTargetType; id: string; label: string };
type CallOutcome = 'connected' | 'timeout' | 'failed';

/**
 * 受付完了画面へ提示する退館クレデンシャル (issue #342)。/api/kiosk/checkout/issue の戻り値。
 * token/code は秘密（PII ではない）。ログには出さず表示のためだけに保持する。
 */
type CheckoutCredential = { token: string; code: string; expiresAt: string };

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
  // 待機画面リードの既定文言 (#324)。主指示（「ご用件をお選びください」）は見出し・アバター字幕が
  // 担うため、リードは挨拶＋安心情報（タッチだけで受付できる）のみにして指示を二重化しない。
  // ja は管理設定 (#28) で上書き可能。
  const [guidanceIdle, setGuidanceIdle] = useState('ようこそ。タッチ操作だけで受付できます。');
  // 来訪者向けプライバシー通知の要約文言の上書き (issue #28 / #314)。未設定なら i18n 既定文言を使う。
  const [privacyNoticeOverride, setPrivacyNoticeOverride] = useState<string | undefined>(undefined);
  // 受付の表示言語 (#103)。来訪者が待機画面の LanguageSwitcher で切替える（セッション内で保持）。
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  // 無操作リセット直前のカウントダウン警告（#125 UX, "don't surprise-expire"）。null=非表示。
  const [inactivitySeconds, setInactivitySeconds] = useState<number | null>(null);
  // 「続ける」ボタンから無操作タイマーを延長するための ref（実体は inactivity effect 内で設定）。
  const extendInactivityRef = useRef<() => void>(() => {});
  const [speakSettings, setSpeakSettings] = useState<SpeakSettings>({ ttsEnabled: false, rate: 1, volume: 1, language: 'ja-JP' });
  const [sttEnabled, setSttEnabled] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | undefined>(undefined);
  // テナントのブランド設定（ロゴ/アクセント色/社名）。「会社の顔」テーマ注入 (#88)。
  const [branding, setBranding] = useState<BrandingSettings>({});
  const [vrmUrl, setVrmUrl] = useState<string | undefined>(undefined);
  const [avatarFallbackUrl, setAvatarFallbackUrl] = useState<string | undefined>(undefined);
  // 状態別モーション URL（#31）。default URL に fallback して VRM レンダラへ渡す。
  const [motions, setMotions] = useState<{ motions: Partial<Record<MotionKey, string>>; defaultUrl?: string }>({
    motions: {},
  });
  // null=取得前/取得失敗（既定で表示継続）、false=失効、true=有効。
  const [active, setActive] = useState<boolean | null>(null);
  // kiosk セッション保持状態 (issue #239)。null=heartbeat 取得前（楽観的に表示継続）、
  // false=未保持（ゲートで受付フローを出さない）、true=保持。
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  // PIN 必須設定 (issue #23)。未保持時に PIN 自己許可へ誘導するか未エンロール案内かを分ける。
  const [pinRequired, setPinRequired] = useState(false);
  // オンライン状態。heartbeat 失敗で false、復帰で true (issue #30)。
  const [online, setOnline] = useState(true);
  // 受付モード。idle から「QRで受付」を選ぶと checkin へ。完了/通常受付選択で normal へ戻す (issue #98)。
  const [mode, setMode] = useState<'normal' | 'checkin'>('normal');
  // 逃げ道バーの実測高さ。チャット FAB をこの上へ確実に持ち上げ重なりを防ぐ (#121 H1)。
  // バーは flex-wrap で複数行になりうるため固定値ではなく実測する。
  const escapeBarRef = useRef<HTMLElement | null>(null);
  const [escapeBarHeight, setEscapeBarHeight] = useState(0);

  // 逃げ道バーの高さを実測してチャット FAB の持ち上げ量に反映する (#121 H1)。
  // バーの表示/段数が状態で変わるため data.state を依存に再観測する。
  useEffect(() => {
    const el = escapeBarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      setEscapeBarHeight(0);
      return;
    }
    const measure = () => setEscapeBarHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data.state]);

  // カスタム受付フロー (issue #100)。null=取得前/失敗、[]=無効（既定フローへフォールバック）。
  const [customFlows, setCustomFlows] = useState<KioskCustomFlow[] | null>(null);
  // 来訪者が目的選択で選んだカスタムフロー。null のときは既定フローのまま進む。
  const [selectedFlow, setSelectedFlow] = useState<KioskCustomFlow | null>(null);
  // 待機サイネージ (issue #101)。再生可能項目数だけ保持し、idle 中の待機表示判定に使う。
  const [signageCount, setSignageCount] = useState(0);
  // 来訪者検知カメラの有効化トグル (issue #79)。既定 OFF（タップ起動が常に生きる）。
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  // 受付完了時に発行された退館クレデンシャル (issue #342)。null=未発行/発行失敗（QR 非表示で継続）。
  // 完了画面に退館 QR / 短コード / 有効期限を提示する。idle 復帰で破棄する（次の来訪者へ持ち越さない）。
  const [checkoutCredential, setCheckoutCredential] = useState<CheckoutCredential | null>(null);
  // ワンタップ満足度フィードバック収集の有効/無効 (issue #320)。テナント設定 (#28) を尊重する。
  // 既定 true（未取得/未設定は収集する）。false のときは終端画面から評価 UI 自体を出さない。
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  // 来訪者が選べるアクセシビリティ支援モード (issue #321)。文字サイズ・ハイコントラスト・
  // 低位置レイアウトの現在値。既定は無支援（DEFAULT_A11Y_MODE_STATE）で、セッション終了・
  // 無操作リセットで idle 復帰時に既定へ戻す（次の来訪者へ持ち越さない、下記 idle effect 参照）。
  const [fontScale, setFontScale] = useState<FontScale>(DEFAULT_A11Y_MODE_STATE.fontScale);
  const [a11yHighContrast, setA11yHighContrast] = useState(DEFAULT_A11Y_MODE_STATE.highContrast);
  const [a11yLowReach, setA11yLowReach] = useState(DEFAULT_A11Y_MODE_STATE.lowReach);
  // テナント/サイト設定でのモードごとの有効/無効 (issue #321 AC)。未取得時は既定=全モード有効。
  const [a11yEnabledModes, setA11yEnabledModes] = useState<A11yEnabledModes>(
    sanitizeA11yEnabledModes(undefined),
  );
  // テナント設定の取得後にモードが無効化されていた場合、既に選ばれていた値を既定へ丸める
  // （#321: 無効モードの残留表示を防ぐ。clampA11yModeState は純関数、src/domain/kiosk/a11y-modes.ts）。
  useEffect(() => {
    const clamped = clampA11yModeState(
      { fontScale, highContrast: a11yHighContrast, lowReach: a11yLowReach },
      a11yEnabledModes,
    );
    if (clamped.fontScale !== fontScale) setFontScale(clamped.fontScale);
    if (clamped.highContrast !== a11yHighContrast) setA11yHighContrast(clamped.highContrast);
    if (clamped.lowReach !== a11yLowReach) setA11yLowReach(clamped.lowReach);
    // fontScale/a11yHighContrast/a11yLowReach は「クランプ対象」であり、この effect 自身の
    // setState で変わりうるため依存に含めない（a11yEnabledModes の変化にのみ反応する）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a11yEnabledModes]);
  // 呼び出し中(calling)の段階的ケア (issue #323)。しきい値・文言はテナント設定 (#28) を尊重する。
  // 未取得時は既定値のまま（クランプ側が既定へフォールバックするため壊れない）。
  const [callingStageTenantOverride, setCallingStageTenantOverride] = useState<
    Partial<CallingStageThresholds>
  >({});
  const [callingStageTextOverride, setCallingStageTextOverride] = useState<{
    waiting?: string;
    notice?: string;
  }>({});
  // E2E タイマー短縮用のクエリ上書き（`?callingStageMs=` 等、既存 `?inactivityMs=` の流儀）。
  // window 参照は SSR 不一致を避けるため effect 内でのみ行う。
  const [callingStageQueryOverride, setCallingStageQueryOverride] = useState<
    Partial<CallingStageThresholds>
  >({});
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const num = (key: string): number | undefined => {
      const v = Number(params.get(key));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    setCallingStageQueryOverride({
      waitingAfterMs: num('callingStageMs'),
      noticeAfterMs: num('callingNoticeMs'),
      noticeMinDurationMs: num('callingNoticeHoldMs'),
    });
  }, []);
  // テナント設定 → E2E クエリの順で重ねてしきい値を確定する（クエリが最優先, #323）。
  const callingStageThresholds = useMemo(
    () =>
      clampCallingStageThresholds(
        callingStageQueryOverride,
        clampCallingStageThresholds(callingStageTenantOverride),
      ),
    [callingStageTenantOverride, callingStageQueryOverride],
  );
  // 呼び出し(calling)開始時刻。経過 ms の起点で、calling を抜けたら null に戻す（次回呼び出しで
  // 取り直す）。UI 層のタイマー派生のみに使い、state.ts の遷移表・screenState は変えない。
  const callingStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    callingStartedAtRef.current = data.state === 'calling' ? Date.now() : null;
  }, [data.state]);
  // 呼び出しの calling-effect（下記）は data.purpose/target/visitor 等の変化でも再実行されうるが、
  // しきい値の変化では再実行させたくない（無関係な再作成で受付を再作成してしまう事故を防ぐ）。
  // そのため ref 経由で「その時点の最新しきい値」だけを参照する。
  const callingStageThresholdsRef = useRef<CallingStageThresholds>(callingStageThresholds);
  useEffect(() => {
    callingStageThresholdsRef.current = callingStageThresholds;
  }, [callingStageThresholds]);
  // 予告を見せてから実際に CALL_TIMEOUT を dispatch するための遅延タイマー（#323 AC3）。
  const timeoutDispatchTimerRef = useRef<number | null>(null);
  // 呼び出し中の表示段階（dialing/waiting/preTimeoutNotice）。CallingView とアバターコンパニオンの
  // 両方が同じ経過時刻（callingStartedAtRef）・しきい値から導出するため常に一致する。
  const callingStageState = useCallingStage(
    data.state === 'calling',
    callingStartedAtRef,
    callingStageThresholds,
  );
  // アバター常設コンパニオンの段階演出 (#323)。avatarState 自体は変えず、同じ avatarState
  // ('calling') 内の字幕/表情だけを差し替える（見た目の演出のみ・状態機械は不変）。
  // dialing 段階は既存どおり avatarState 標準の文言（新規表示を増やさない）。
  const callingAvatarGuidanceOverride: AvatarGuidanceOverride | undefined = useMemo(() => {
    if (data.state !== 'calling' || callingStageState.stage === 'dialing') return undefined;
    return {
      text: callingStageMessage(callingStageState.stage, data.target?.label ?? '', locale, callingStageTextOverride),
      expression: callingStageState.stage === 'preTimeoutNotice' ? 'concerned' : undefined,
    };
  }, [data.state, data.target?.label, callingStageState.stage, locale, callingStageTextOverride]);

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
      setAuthorized(hb.authorized);
      setPinRequired(hb.pinRequired);
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
          privacyNotice?: string;
          callingStageWaitingAfterMs?: number;
          callingStageNoticeAfterMs?: number;
          guidanceCallingWaiting?: string;
          guidanceCallingNotice?: string;
          feedbackEnabled?: boolean;
          a11yModesEnabled?: Partial<A11yEnabledModes>;
        };
        if (cancelled) return;
        if (voice.guidanceIdle) setGuidanceIdle(voice.guidanceIdle);
        setPrivacyNoticeOverride(voice.privacyNotice);
        setSttEnabled(voice.sttEnabled ?? false);
        setSpeakSettings({
          ttsEnabled: voice.ttsEnabled ?? false,
          rate: voice.rate ?? 1,
          volume: voice.volume ?? 1,
          language: voice.language ?? 'ja-JP',
        });
        // 呼び出し中の段階的ケア (issue #323)。テナント設定のしきい値・案内文言の上書き。
        setCallingStageTenantOverride({
          waitingAfterMs: voice.callingStageWaitingAfterMs,
          noticeAfterMs: voice.callingStageNoticeAfterMs,
        });
        setCallingStageTextOverride({
          waiting: voice.guidanceCallingWaiting,
          notice: voice.guidanceCallingNotice,
        });
        // ワンタップ満足度フィードバック収集の有効/無効 (issue #320)。未設定は収集する（既定 true）。
        setFeedbackEnabled(voice.feedbackEnabled ?? true);
        // アクセシビリティ支援モードの有効/無効 (issue #321)。未設定は全モード有効扱い。
        setA11yEnabledModes(sanitizeA11yEnabledModes(voice.a11yModesEnabled));
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

  // テナントのブランド設定を取得（#88）。失敗時は汎用テーマのまま。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/kiosk/branding');
        if (!res.ok) return;
        const data = (await res.json()) as BrandingSettings;
        if (!cancelled) setBranding(data);
      } catch {
        /* 取得失敗時は汎用テーマ */
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

  // 受付体験メトリクスの計測 (issue #319)。PII を含まない所要/回数/入力手段を集計し、呼び出し作成時に
  // サーバへ同送する（現状サーバは未知フィールドとして無視。永続化は次増分）。計測は非破壊で受付挙動を
  // 変えない。ref で保持し、状態遷移・戻る/キャンセル・入力手段イベントごとにイミュータブルに置換する。
  const experienceRef = useRef<ExperienceTracker>(createTracker());
  const prevStepRef = useRef<ReturnType<typeof stepForState>>(null);

  const markInputMethod = useCallback((method: Parameters<typeof recordInputMethod>[1]) => {
    experienceRef.current = recordInputMethod(experienceRef.current, method);
  }, []);
  // 音声検索の採用を主入力手段=音声として記録する安定ハンドラ (issue #319)。renderScreen は
  // 素の関数呼び出しのため、ref を触る処理は（インライン arrow ではなく）useCallback で渡す
  // （react-hooks/refs: レンダー中に ref を触らない）。実行はクリック時のみ。
  const markVoiceInput = useCallback(() => markInputMethod('stt'), [markInputMethod]);
  // 担当者検索の実行（ヒット有無のみ）をヒット率/0 件率フックへ記録する安定ハンドラ (issue #322)。
  // クエリ文字列や検索結果自体は ref に持ち込まない（PII 最小化）。
  const markSearchQuery = useCallback((hasHit: boolean) => {
    experienceRef.current = recordSearchQuery(experienceRef.current, hasHit);
  }, []);

  // 検索 0 件時などから Chat-assisted ドロワーを外部から開く合図 (issue #322)。値の増加を
  // KioskChatDrawer 側の effect が検知して開く（ドロワーは自身の開閉状態を所有したまま）。
  const [chatOpenSignal, setChatOpenSignal] = useState(0);
  const requestChatOpen = useCallback(() => setChatOpenSignal((n) => n + 1), []);

  // 状態遷移から体験メトリクスを計測する (issue #319)。ステップ滞在所要・呼び出し到達までの所要・
  // 「戻る」回数（ステップ後退で検知）・「キャンセル」回数を記録し、idle でトラッカをリセットする。
  // 「calling」への create 副作用より前に定義し、作成時スナップショットで timeToCall が確定するようにする。
  useEffect(() => {
    if (data.state === 'idle') {
      experienceRef.current = createTracker();
      prevStepRef.current = null;
      return;
    }
    const step = stepForState(data.state);
    if (step) {
      const prev = prevStepRef.current;
      if (prev && EXPERIENCE_STEP_ORDER.indexOf(step) < EXPERIENCE_STEP_ORDER.indexOf(prev)) {
        experienceRef.current = recordBack(experienceRef.current);
      }
      experienceRef.current = enterStep(experienceRef.current, step, Date.now());
      prevStepRef.current = step;
    } else if (data.state === 'cancelled') {
      experienceRef.current = recordCancel(experienceRef.current);
    }
  }, [data.state]);

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
            // kioskId は送らない: サーバが認証済み kiosk セッション（cookie）から確定する
            // (issue #348)。クライアント値は信用されないため、ハードコードした固定 ID を
            // 送ると実セッションと食い違い、以後の status/stay 所有権チェックが 403 になる。
            purpose: data.purpose,
            // カスタムフロー選択時は purposeKey も併送する（サーバ将来拡張用・未知でも非破壊）(issue #100)。
            purposeKey: selectedFlow?.purposeKey,
            targetType: data.target?.type,
            targetId: data.target?.id,
            targetLabel: data.target?.label,
            visitor: data.visitor,
            // 体験メトリクス (issue #319)。PII を含まない所要/回数/入力手段。呼び出し到達時点の
            // スナップショット（timeToCall はこの時点で確定）。サーバ未対応時は無視される（非破壊）。
            experience: finalizeExperience(experienceRef.current, {
              abandoned: false,
              nowMs: Date.now(),
            }),
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
        else if (result.state === 'timeout') {
          // タイムアウト直前の予告を挟んでから実遷移する (issue #323 AC3)。予告
          // （preTimeoutNotice 段階）を最低 noticeMinDurationMs は見せてから CALL_TIMEOUT を
          // dispatch する。state.ts の遷移表自体は変えず、「いつ dispatch するか」だけを
          // UI 層で遅らせる。しきい値は ref 経由（この effect の再実行トリガーにはしない）。
          const startedAt = callingStartedAtRef.current;
          const elapsedMs = startedAt !== null ? Date.now() - startedAt : 0;
          const delayMs = timeoutDispatchDelayMs(elapsedMs, callingStageThresholdsRef.current);
          if (delayMs <= 0) {
            dispatch({ type: 'CALL_TIMEOUT', sessionId: session.id });
          } else {
            timeoutDispatchTimerRef.current = window.setTimeout(() => {
              if (!cancelled) dispatch({ type: 'CALL_TIMEOUT', sessionId: session.id });
            }, delayMs);
          }
        }
        // 'calling' は Vonage（非同期）: ビデオビューが応答/未応答を確定する。
        else if (result.state === 'calling') setVonageCallId(session.id);
        else dispatch({ type: 'CALL_FAILED', sessionId: session.id });
      } catch {
        if (!cancelled) dispatch({ type: 'CALL_FAILED' });
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutDispatchTimerRef.current !== null) {
        window.clearTimeout(timeoutDispatchTimerRef.current);
        timeoutDispatchTimerRef.current = null;
      }
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
    if (!shouldResetOnInactivity(data.state)) {
      setInactivitySeconds(null);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const override = Number(params.get('inactivityMs'));
    // connected（来訪待ち）は長めの上限を使う (#324)。?inactivityMs= の明示指定は常に優先（E2E 短縮用）。
    const base = data.state === 'connected' ? CONNECTED_INACTIVITY_RESET_MS : INACTIVITY_RESET_MS;
    const limit = Number.isFinite(override) && override > 0 ? override : base;
    // 警告（カウントダウン）に割く時間は limit を超えない範囲で確保する。
    const warnMs = Math.min(INACTIVITY_WARNING_MS, Math.max(0, limit - 500));
    const warnAfter = Math.max(0, limit - warnMs);

    let warnTimer = 0;
    let interval = 0;

    // 残り warnMs になったらカウントダウン警告を表示し、毎秒減らして 0 でリセットする。
    const startCountdown = () => {
      let remaining = Math.max(1, Math.ceil(warnMs / 1000));
      setInactivitySeconds(remaining);
      interval = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          window.clearInterval(interval);
          dispatch({ type: 'RESET' });
        } else {
          setInactivitySeconds(remaining);
        }
      }, 1000);
    };

    const schedule = () => {
      warnTimer = window.setTimeout(startCountdown, warnAfter);
    };

    // 何か操作されたら警告を消し、無操作タイマーを最初から測り直す（=延長）。
    const bump = () => {
      window.clearTimeout(warnTimer);
      window.clearInterval(interval);
      interval = 0;
      setInactivitySeconds(null);
      schedule();
    };

    extendInactivityRef.current = bump;
    schedule();
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.clearTimeout(warnTimer);
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      setInactivitySeconds(null);
    };
  }, [data.state]);

  // idle へ戻ったら選んだカスタムフローを破棄し、表示言語も既定へ戻す（次の来訪者へ持ち越さない）
  // (issue #100 / #103)。待機中の言語切替はそのまま有効（idle に居る間は state 遷移しないため）。
  useEffect(() => {
    if (data.state === 'idle') {
      setSelectedFlow(null);
      setLocale(DEFAULT_LOCALE);
      // 退館クレデンシャル (#342) を破棄する（次の来訪者の完了画面へ持ち越さない）。
      setCheckoutCredential(null);
      // アクセシビリティ支援モードも既定へ戻す (issue #321 AC「既定表示へ自動復帰」)。
      // 上の setLocale(DEFAULT_LOCALE) がやさしい日本語 ('ja-simple') も既定 'ja' へ戻す。
      setFontScale(DEFAULT_A11Y_MODE_STATE.fontScale);
      setA11yHighContrast(DEFAULT_A11Y_MODE_STATE.highContrast);
      setA11yLowReach(DEFAULT_A11Y_MODE_STATE.lowReach);
    }
  }, [data.state]);

  // 音声合成が有効な場合、状態に応じた案内を「選択中の言語」で読み上げる (issue #5 / #103)。
  // 文言は表示と同じ辞書から引き、発話言語(BCP-47)も locale に合わせる（ja は管理設定の language を尊重）。
  useEffect(() => {
    const tr = makeT(locale);
    const target = data.target?.label ?? '';
    let phrase: string | undefined;
    switch (data.state) {
      case 'calling':
        phrase = tr('reception.callingBody', { target });
        break;
      case 'connected':
        phrase = tr('reception.connectedBody', { target });
        break;
      case 'timeout':
        phrase = tr('reception.timeoutBody');
        break;
      case 'failed':
        phrase = tr('reception.failedBody');
        break;
      case 'completed':
        phrase = tr('reception.thanks');
        break;
      case 'idle':
        // 待機の発話は視覚リードと同じ役割（挨拶＋安心情報）に揃える (#324)。旧「タッチして開始」
        // （welcome.tapToStart）は 1画面1メッセージ設計から外したため発話でも再導入しない。
        // ja は管理設定の案内文言（guidanceIdle＝リード）を、他言語は挨拶＋idleReassure を読み上げる。
        phrase =
          locale === DEFAULT_LOCALE
            ? guidanceIdle
            // 'ja-simple' は日本語の一種なので 'zh' と同じ全角句点区切りにする (#321)。
            : `${tr('welcome.title')}${locale === 'zh' || locale === 'ja-simple' ? '。' : '. '}${tr('reception.idleReassure')}`;
        break;
      default:
        phrase = undefined;
    }
    if (phrase) {
      const language =
        locale === DEFAULT_LOCALE ? speakSettings.language : LOCALE_LANGUAGE_CODE[locale];
      speak(phrase, { ...speakSettings, language });
    }
  }, [data.state, data.target?.label, guidanceIdle, speakSettings, locale]);

  // 受付完了時に在館記録を自動生成し、退館クレデンシャルを発行して完了画面へ提示する (issue #342)。
  // 失敗しても受付完了画面の表示・自動リセットは妨げない（ホットパスを止めない・来訪者をブロックしない）。
  // token/code はここでもログに出さない（PII ではないが秘密）。
  const issueCheckoutCredential = useCallback(async (receptionId: string) => {
    try {
      const stayRes = await fetch('/api/kiosk/stay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receptionId }),
      });
      if (!stayRes.ok) {
        // 沈黙させず観測可能にする（step/status のみ。token/PII は載せない）。
        console.warn('[kiosk] checkout credential issuance failed', { step: 'stay', status: stayRes.status });
        return;
      }
      const { stayId } = (await stayRes.json()) as { stayId?: string };
      if (!stayId) return;
      const issueRes = await fetch('/api/kiosk/checkout/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stayId }),
      });
      if (!issueRes.ok) {
        console.warn('[kiosk] checkout credential issuance failed', { step: 'issue', status: issueRes.status });
        return;
      }
      const cred = (await issueRes.json()) as Partial<CheckoutCredential>;
      if (cred.token && cred.code && cred.expiresAt) {
        setCheckoutCredential({ token: cred.token, code: cred.code, expiresAt: cred.expiresAt });
      }
    } catch (e) {
      /* 退館クレデンシャル発行の失敗は受付完了画面を妨げない（QR 非表示で継続） */
      console.warn('[kiosk] checkout credential issuance failed', { step: 'issue', error: e });
    }
  }, []);

  const complete = useCallback(async () => {
    if (data.sessionId) {
      try {
        await fetch(`/api/kiosk/receptions/${data.sessionId}/complete`, { method: 'POST' });
      } catch {
        /* 完了通知の失敗は受付フローを止めない */
      }
      // 担当者応答で完了した受付のみ在館化し退館クレデンシャルを提示する (#342)。
      // 非同期で走らせ、完了画面の表示・自動リセットを遅らせない（発行できたら QR を後追い表示）。
      if (data.outcome === 'connected') void issueCheckoutCredential(data.sessionId);
    }
    dispatch({ type: 'COMPLETE' });
  }, [data.sessionId, data.outcome, issueCheckoutCredential]);

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

  /**
   * ワンタップ満足度フィードバックの送信 (issue #320)。完了/未応答/失敗の終端画面から呼ばれる。
   * fire-and-forget（結果を待たず、失敗しても状態機械には触れない）: 評価は既存の自動復帰
   * タイマー（AUTO_RESET_MS・無操作リセット）を一切延長・変更しない。未評価のまま放置しても
   * 挙動は変わらない（SatisfactionFeedback 側は評価が無ければ何も送らない）。
   */
  const submitFeedback = useCallback(
    (rating: SatisfactionRating, reasonCodes: FeedbackReasonCode[]) => {
      if (!data.sessionId) return;
      void fetch(`/api/kiosk/receptions/${data.sessionId}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, reasonCodes }),
      }).catch(() => {
        /* 送信失敗は受付フローを止めない（評価は完全任意, #320 AC） */
      });
    },
    [data.sessionId],
  );

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

  // /kiosk アクセスゲート (issue #239)。セッション未保持なら受付フローを出さず誘導する。
  const view = resolveKioskGate({ active, authorized, pinRequired });

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

  // ブランドのアクセント色で CSS 変数 --brand-accent を上書きしてテーマ化する (#88)。
  const brandAccent = normalizeAccentColor(branding.accentColor);
  const backgroundStyle: React.CSSProperties = {
    // ハイコントラストモード (#321) では背景画像を出さない（前景/背景コントラストを
    // globals.css の data-a11y-contrast トークンで確実に確保するため）。ブランド accent
    // （--brand-accent）は保持する（AC「ブランド accent は保持しつつコントラストを強化」）。
    ...(backgroundUrl && !a11yHighContrast
      ? { backgroundImage: `url(${backgroundUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : {}),
    ...(brandAccent ? ({ '--brand-accent': brandAccent } as React.CSSProperties) : {}),
  };

  return (
    <main
      className="screen"
      data-kiosk-state={view === 'ready' ? data.state : view}
      // 受付状態に対応するモーションキー。VRM レンダラ（#5）が消費する (issue #31)。
      data-kiosk-motion={motionKeyForState(data.state)}
      // 画面種別レイアウトプロファイル。配置は CSS が消費する (issue #124)。
      data-kiosk-layout={layout}
      // 来訪者が選べるアクセシビリティ支援モード (issue #321)。配置・配色・文字サイズの
      // 切り替えは globals.css がこれらの属性セレクタで担う（JS はスタイルを持たない）。
      data-a11y-font-scale={fontScale}
      data-a11y-contrast={a11yHighContrast ? 'high' : undefined}
      data-a11y-reach={a11yLowReach ? 'low' : undefined}
      style={backgroundStyle}
    >
      {/*
        常設アクセシビリティ支援モードボタン (issue #321 AC「全 kiosk 画面でモード切替が
        1〜2タップで到達できる」)。view/mode/showSignage の分岐の外側（<main> 直下）に置き、
        PIN 許可待ち・未エンロール案内・QR 受付・待機サイネージ・受付フローの全画面で
        同じ場所に常設する。
      */}
      <AccessibilityMenu
        fontScale={fontScale}
        onFontScale={setFontScale}
        highContrast={a11yHighContrast}
        onHighContrast={setA11yHighContrast}
        lowReach={a11yLowReach}
        onLowReach={setA11yLowReach}
        locale={locale}
        onSimpleJapaneseChange={(enabled) => setLocale(enabled ? 'ja-simple' : DEFAULT_LOCALE)}
        enabledModes={a11yEnabledModes}
      />
      {inactivitySeconds !== null ? (
        <InactivityWarning
          seconds={inactivitySeconds}
          locale={locale}
          onContinue={() => extendInactivityRef.current()}
        />
      ) : null}
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
        <KioskAuthorizeView onAuthorized={() => setAuthorized(true)} />
      ) : view === 'unenrolled' ? (
        <KioskUnenrolledView />
      ) : view === 'checking' ? (
        <KioskCheckingView />
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
          locale={locale}
        />
      ) : useCustomFlow && data.state === 'selectingPurpose' ? (
        // カスタム目的選択 (issue #100)。選択でフローを保持し、入力ステップ有無で次へ分岐。
        <CustomPurposeView
          flows={customFlows ?? []}
          onSelect={(flow) => {
            setSelectedFlow(flow);
            dispatch({ type: 'SELECT_PURPOSE', purpose: purposeIdForFlow(flow) });
          }}
        />
      ) : useCustomFlow && selectedFlow && data.state === 'inputVisitorInfo' ? (
        // カスタム来訪者情報入力 (issue #100)。確認・呼び出しは既存状態機械へ委譲。
        <CustomVisitorInfoView
          flow={selectedFlow}
          onSubmit={(values) =>
            dispatch({ type: 'SUBMIT_VISITOR_INFO', visitor: flowValuesToVisitorInfo(selectedFlow, values) })
          }
          locale={locale}
          privacyNoticeOverride={privacyNoticeOverride}
          presenceCameraEnabled={presenceEnabled}
        />
      ) : (
        <>
          <FlowStepper state={data.state} locale={locale} />
          {/* 画面遷移ごとに key を変え、上品な入場アニメを再生する（#119 UX 仕上げ）。 */}
          <div className="screen-anim" key={data.state}>
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
              locale,
              setLocale,
              branding,
              // renderScreen は素の関数のため lint はこの引数をレンダー中の ref アクセスと誤検知する。
              // markVoiceInput は音声候補クリック時のみ実行される（レンダー中に ref を触らない）(issue #319)。
              // eslint-disable-next-line react-hooks/refs -- クリック時のみ実行される安定コールバック
              markVoiceInput,
              // 受付完了画面に提示する退館クレデンシャル (#342)。connected 完了時のみ非 null。
              checkoutCredential,
              privacyNoticeOverride,
              presenceEnabled,
              // markVoiceInput と同様、レンダー中には呼ばれない安定コールバック（デバウンス後の
              // 検索実行時のみ ref を更新する, issue #322）。
              // eslint-disable-next-line react-hooks/refs -- クリック/検索実行時のみ実行される安定コールバック
              markSearchQuery,
              requestChatOpen,
              // 呼び出し中の段階的ケア (#323)。UI 層のタイマー派生（state.ts/ui-contract.ts は不変）。
              callingStageState,
              callingStageTextOverride,
              // ワンタップ満足度フィードバック (#320)。完了/未応答/失敗画面のみが使う。
              { enabled: feedbackEnabled, onSubmit: submitFeedback },
            )}
          </div>
          {/*
            #123 アバター常設コンパニオン。screenState（=data.state）から表情/モーション/字幕を
            導出し受付に「付き添う」。pointer-events:none で操作は妨げない。
            選択/入力画面はカードや入力欄でコンテンツが密集し重なるため出さず、中央寄せで余白のある
            ステータス画面（呼び出し中/結果/お詫び/完了）に限定する。ここはアバターの感情表現
            （呼び出し中=気遣い・完了=お見送り・失敗=お詫び）が最も活きる場面でもある。
            待機画面は IdleView 側がヒーローとして大きく表示する。
          */}
          {showAvatarCompanion(data.state) ? (
            <div className="kiosk-avatar-companion" aria-hidden="true">
              <AvatarGuide
                screenState={data.state}
                locale={locale}
                vrmUrl={vrmUrl}
                fallbackImageUrl={avatarFallbackUrl}
                defaultMotionUrl={motionUrl}
                guidanceOverride={callingAvatarGuidanceOverride}
              />
            </div>
          ) : null}
          {/* 退館チェックアウト導線 (issue #102)。待機中のみ小さく常設する（非破壊）。 */}
          {data.state === 'idle' ? <CheckoutLink locale={locale} /> : null}
          {/*
            常時見える「逃げ道」バー (issue #121 / #325)。後退系コントロールはここに一本化し、
            戻る（1 ステップ）/ 最初に戻る（リセット）の 2 語だけを出す。出すアクションは #120 契約の
            availableActions に従う（許可外は出さない）。各画面のコンテンツ側は前進系（主 CTA）と
            文脈固有（修正する）に限定し、後退ボタンは置かない（同一機能ボタンの二重表示を解消）。
          */}
          <EscapeHatchBar
            barRef={escapeBarRef}
            state={data.state}
            onAction={(action) => {
              // escapeHatchesFor が返すのは back/reset のみ（#325）。状態機械イベントへ写す。
              const eventByAction: Partial<Record<ReceptionAction, Action>> = {
                back: { type: 'BACK' },
                reset: { type: 'RESET' },
              };
              const next = eventByAction[action];
              if (next) dispatch(next);
            }}
          />
          {/*
            #122 Chat-assisted ドロワー (#124 で配線)。利用可否は deriveChatAvailability(state) に従い、
            idle/終端では自動で閉じ・履歴を破棄する（ドロワー側で null を返す→スロットは :empty で非表示）。
            ドロワーは状態を所有せず、許可済みアクションのタッチ確定だけを KioskFlow のイベントへ写す。
            重要操作（confirm/submitVisitorInfo）はチャットからは確定不可（contract が弾く）。
          */}
          <div
            className="kiosk-chat-slot"
            data-slot="chat-drawer"
            style={
              escapeBarHeight > 0
                ? ({ '--kiosk-chat-safe-bottom': `${escapeBarHeight + 16}px` } as React.CSSProperties)
                : undefined
            }
          >
            <KioskChatDrawer
              screenState={data.state}
              available={deriveChatAvailability(data.state) === 'available'}
              // 担当者検索 0 件時の「チャットで相談する」ボタンから開く合図 (issue #322)。
              openSignal={chatOpenSignal}
              onRequestStaff={() => {
                markInputMethod('chat');
                void handleFallback();
              }}
              onAction={(action) => {
                // チャットから操作された＝主入力手段はチャット (issue #319)。
                markInputMethod('chat');
                // useFallback/complete は記録 API を伴う専用ハンドラへ。残りは状態機械イベントへ写す。
                if (action === 'useFallback') return void handleFallback();
                if (action === 'complete') return void complete();
                // 文脈不要な安全アクションのみ写す。選択系（payload 必要）/重要操作は契約上ここへ来ない。
                const eventByAction: Partial<Record<ReceptionAction, Action>> = {
                  back: { type: 'BACK' },
                  cancel: { type: 'CANCEL' },
                  reset: { type: 'RESET' },
                };
                const next = eventByAction[action];
                if (next) dispatch(next);
              }}
            />
          </div>
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
  barRef,
}: {
  state: ReceptionState;
  onAction: (action: ReceptionAction) => void;
  barRef?: React.Ref<HTMLElement>;
}) {
  const hatches: ReadonlyArray<EscapeHatch> = escapeHatchesFor(state);
  if (hatches.length === 0) return null;
  return (
    <nav
      ref={barRef}
      className="kiosk-escape-bar"
      data-testid="kiosk-escape-bar"
      aria-label="受付の操作（戻る・最初に戻る）"
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
 * 未エンロール案内 (issue #239)。kiosk セッション未保持・PIN 不要設定のとき、受付フローを出さず
 * 「この端末はまだ受付用に設定されていない」ことと、管理発行の受付URL/QRでエンロールする導線を示す。
 * 自己許可手段（PIN）が無いため来訪者操作で先へ進ませない。PII・秘密は一切出さない。
 */
/**
 * セッション確認中の中立表示 (issue #239)。heartbeat で kiosk セッションの有無が確定するまで
 * 受付フローを出さない（fail-closed）。確定後に ready / unenrolled / authorize へ分岐する。
 */
function KioskCheckingView() {
  return (
    <div
      className="screen__body"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
      data-testid="kiosk-checking"
    >
      <p className="screen__lead">受付端末を確認しています…</p>
    </div>
  );
}

function KioskUnenrolledView() {
  return (
    <div
      className="screen__body"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 'var(--space-md)' }}
      data-testid="kiosk-unenrolled"
    >
      <h1 className="screen__title">受付端末の設定が必要です</h1>
      <p className="screen__lead">
        この端末はまだ受付用に登録されていません。担当者が管理画面で発行する受付 URL / QR コードから
        エンロールしてください。
      </p>
      <p className="notice notice--info">設定が完了すると、この画面から受付を開始できます。</p>
    </div>
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
  locale,
}: {
  onStart: () => void;
  onStartCheckin: () => void;
  presenceEnabled: boolean;
  onTogglePresence: () => void;
  presenceStatus: PresenceCameraStatus;
  /**
   * 表示言語 (#327)。埋め込み SignageDisplay・退館チェックアウト導線 (CheckoutLink)・
   * QR 受付/来訪検知トグルの各文言に共通で使う（以前は SignageDisplay と QR/来訪検知の
   * 2 箇所が locale に連動しない翻訳漏れだった）。
   */
  locale: Locale;
}) {
  const tr = makeT(locale);
  return (
    <div data-testid="kiosk-signage-waiting" style={{ position: 'relative', minHeight: '100%' }}>
      <SignageDisplay onStart={onStart} locale={locale} />
      <div
        className="screen__footer"
        style={{ position: 'absolute', bottom: 'var(--space-md)', left: 0, right: 0, justifyContent: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}
      >
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="signage-start-checkin"
          lang={htmlLangFor(locale)}
          onClick={onStartCheckin}
        >
          {tr('kiosk.action.checkin.label')}
        </button>
        <CheckoutLink locale={locale} />
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="presence-toggle"
          aria-pressed={presenceEnabled}
          lang={htmlLangFor(locale)}
          onClick={onTogglePresence}
        >
          {presenceEnabled
            ? presenceStatus === 'unavailable'
              ? tr('kiosk.signage.presenceUnavailable')
              : tr('kiosk.signage.presenceOn')
            : tr('kiosk.signage.presenceOff')}
        </button>
      </div>
    </div>
  );
}

/**
 * 退館チェックアウトへの明示導線 (issue #102 / #327 i18n 化)。/kiosk/checkout へ遷移する
 * 小ボタン。選択中の locale を `?locale=` で引き継ぎ、遷移先の CheckoutFlow が同じ言語で
 * 開始できるようにする（KioskFlow と CheckoutFlow はページを跨ぐため React state ではなく
 * クエリで locale を橋渡しする）。
 */
function CheckoutLink({ locale = DEFAULT_LOCALE }: { locale?: Locale }) {
  const tr = makeT(locale);
  return (
    <Link
      href={`/kiosk/checkout?locale=${locale}`}
      className="btn btn--ghost"
      data-testid="kiosk-checkout-link"
      lang={htmlLangFor(locale)}
    >
      {tr('kiosk.checkoutLink')}
    </Link>
  );
}

/** カスタム目的選択画面 (issue #100)。スタンドアロン PurposeSelector を受付画面の枠で包む。 */
function CustomPurposeView({
  flows,
  onSelect,
}: {
  flows: readonly KioskCustomFlow[];
  onSelect: (flow: KioskCustomFlow) => void;
}) {
  // 「最初に戻る」は常設の逃げ道バーに一本化（画面内フッターとの二重表示を解消, #121）。
  return (
    <>
      <div className="screen__body" data-testid="custom-purpose-view">
        <PurposeSelector flows={flows} onSelect={onSelect} />
      </div>
    </>
  );
}

/** カスタム来訪者情報入力画面 (issue #100)。fields が無ければ入力を省略して確認へ進める。 */
function CustomVisitorInfoView({
  flow,
  onSubmit,
  locale,
  privacyNoticeOverride,
  presenceCameraEnabled,
}: {
  flow: KioskCustomFlow;
  onSubmit: (values: FlowFieldValues) => void;
  locale: Locale;
  privacyNoticeOverride: string | undefined;
  presenceCameraEnabled: boolean;
}) {
  // 後退（戻る/最初に戻る）は逃げ道バーへ一本化 (#325)。カスタムフローの入力も inputVisitorInfo 状態
  // なので sticky バーの 戻る/最初に戻る が常時可視。コンテンツ側フッターは前進の主 CTA のみにし、
  // VisitorInfoForm へも onBack を渡さない（フォーム内 戻るとバーの二重表示を解消）。
  if (!flow.steps.includes('visitorInfo') || flow.fields.length === 0) {
    return (
      <>
        <div className="screen__body" data-testid="custom-flow-no-input" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <h1 className="screen__title">{flow.displayName}</h1>
          {flow.description ? <p className="screen__lead">{flow.description}</p> : null}
        </div>
        <div className="screen__footer">
          <button type="button" className="btn btn--primary" data-testid="custom-flow-proceed" onClick={() => onSubmit({})}>
            確認へ進む
          </button>
        </div>
      </>
    );
  }
  return (
    <div className="screen__body" data-testid="custom-visitor-view">
      {/* 来訪者情報を入力させる前に用途・保存有無を明示する (issue #314)。 */}
      <PrivacyNotice
        locale={locale}
        overrideSummary={privacyNoticeOverride}
        presenceCameraEnabled={presenceCameraEnabled}
      />
      <VisitorInfoForm fields={flow.fields} onSubmit={onSubmit} />
    </div>
  );
}

/**
 * 来訪者向けプライバシー通知 (issue #314)。要約は入力ステップで常時表示し、詳細
 * （利用目的・保存の有無・保持期間・問い合わせ先、presence カメラ注記）は折りたたみで読める。
 * タッチのみで開閉でき、大きな文字/コントラストの kiosk UI 基準 (#17) に沿う。
 */
function PrivacyNotice({
  locale,
  overrideSummary,
  presenceCameraEnabled,
}: {
  locale: Locale;
  overrideSummary: string | undefined;
  presenceCameraEnabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = resolvePrivacyNoticeContent(locale, {
    overrideSummary,
    presenceCameraEnabled,
  });
  return (
    <div className="privacy-notice" data-testid="privacy-notice" lang={htmlLangFor(locale)}>
      <p className="privacy-notice__title">{content.title}</p>
      <p className="privacy-notice__summary" data-testid="privacy-notice-summary">
        {content.summary}
      </p>
      <button
        type="button"
        className="privacy-notice__toggle"
        data-testid="privacy-notice-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? content.detailsHideLabel : content.detailsShowLabel}
      </button>
      {expanded ? (
        <dl className="privacy-notice__details" data-testid="privacy-notice-details">
          <dt>{content.purposeLabel}</dt>
          <dd>{content.purposeText}</dd>
          <dt>{content.storageLabel}</dt>
          <dd>{content.storageText}</dd>
          <dt>{content.retentionLabel}</dt>
          <dd>{content.retentionText}</dd>
          <dt>{content.contactLabel}</dt>
          <dd>{content.contactText}</dd>
          {content.presenceCameraNote ? (
            <>
              <dt>{content.presenceCameraLabel}</dt>
              <dd data-testid="privacy-notice-presence-camera">{content.presenceCameraNote}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
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
  locale: Locale,
  onLocaleChange: (next: Locale) => void,
  branding: BrandingSettings,
  /** 音声検索が使われたことを体験メトリクスへ通知する (issue #319)。 */
  onVoiceUse: () => void,
  /** 受付完了画面に提示する退館クレデンシャル (issue #342)。未発行なら null。 */
  checkoutCredential: CheckoutCredential | null,
  /** 来訪者向けプライバシー通知の要約文言の上書き (issue #28 / #314)。未設定は既定文言。 */
  privacyNoticeOverride: string | undefined,
  /** 来訪者検知カメラの有効状態 (issue #79)。有効時のみ通知にローカル処理・非保存の注記を足す。 */
  presenceCameraEnabled: boolean,
  /** 担当者検索の実行を体験メトリクスへ通知する（ヒット有無のみ。PII なし, issue #322）。 */
  onSearchQuery: (hasHit: boolean) => void,
  /** 検索 0 件時などから Chat-assisted ドロワーを開く合図を送る (issue #322)。 */
  onRequestChat: () => void,
  /**
   * 呼び出し中の経過段階 (issue #323)。UI 層のタイマー派生（state.ts/ui-contract.ts は不変）。
   * calling 以外の画面では参照しない。
   */
  callingStageState: { stage: CallingStage; elapsedMs: number },
  /** 呼び出し中の段階的ケアのテナント文言上書き (issue #28 / #323)。ja のみ適用。 */
  callingStageTextOverride: { waiting?: string; notice?: string },
  /**
   * ワンタップ満足度フィードバック (issue #320)。完了/未応答/失敗の終端画面のみが使う。
   * `enabled=false`（テナント設定でオフ）のときは呼び出し側で UI ごと出さない。
   */
  feedback: { enabled: boolean; onSubmit: (rating: SatisfactionRating, reasonCodes: FeedbackReasonCode[]) => void },
) {
  const tr = makeT(locale);
  switch (data.state) {
    case 'idle':
      return (
        <IdleView
          onQuickAction={onQuickAction}
          guidance={guidanceIdle}
          vrmUrl={vrmUrl}
          avatarFallbackUrl={avatarFallbackUrl}
          motionUrl={motionUrl}
          locale={locale}
          onLocaleChange={onLocaleChange}
          branding={branding}
        />
      );
    case 'selectingPurpose':
      return (
        <PurposeView
          onSelect={(purpose) => dispatch({ type: 'SELECT_PURPOSE', purpose })}
          locale={locale}
        />
      );
    case 'selectingTarget':
      return (
        <TargetView
          directory={directory}
          sttEnabled={sttEnabled}
          onSelect={(target) => dispatch({ type: 'SELECT_TARGET', target })}
          onVoiceUse={onVoiceUse}
          onSearchQuery={onSearchQuery}
          onRequestChat={onRequestChat}
          locale={locale}
        />
      );
    case 'inputVisitorInfo':
      return (
        <VisitorInfoView
          initial={data.visitor}
          onSubmit={(visitor) => dispatch({ type: 'SUBMIT_VISITOR_INFO', visitor })}
          locale={locale}
          privacyNoticeOverride={privacyNoticeOverride}
          presenceCameraEnabled={presenceCameraEnabled}
        />
      );
    case 'confirming':
      return (
        <ConfirmView
          data={data}
          onConfirm={() => dispatch({ type: 'CONFIRM' })}
          onBack={() => dispatch({ type: 'BACK' })}
          locale={locale}
        />
      );
    case 'calling':
      // Vonage（非同期）通話はビデオビューがライフサイクルを駆動する。Mock 同期通話は従来表示。
      // 担当者の応答アクションがあれば、その来訪者向けメッセージを上に重ねて表示する (issue #99)。
      return (
        <>
          <StaffResponseBanner
            // respondedAt で key を切り替え、新しい応答が届くたびに入場アニメを再生して
            // 「応答が届いた瞬間」を明確に伝える (issue #323 AC2)。
            key={staffResponse?.respondedAt ?? 'none'}
            response={staffResponse}
            onFallback={onStaffResponseFallback}
            locale={locale}
          />
          {vonageCallId ? (
            <KioskCallView
              receptionId={vonageCallId}
              onConnected={() => dispatch({ type: 'CALL_CONNECTED', sessionId: vonageCallId })}
              onTimeout={() => dispatch({ type: 'CALL_TIMEOUT', sessionId: vonageCallId })}
              onFallback={() => dispatch({ type: 'CALL_FAILED', sessionId: vonageCallId })}
            />
          ) : (
            <CallingView
              target={data.target?.label ?? ''}
              locale={locale}
              stage={callingStageState.stage}
              textOverride={callingStageTextOverride}
            />
          )}
        </>
      );
    case 'connected':
      return (
        <>
          <StaffResponseBanner
            // respondedAt で key を切り替え、新しい応答が届くたびに入場アニメを再生して
            // 「応答が届いた瞬間」を明確に伝える (issue #323 AC2)。
            key={staffResponse?.respondedAt ?? 'none'}
            response={staffResponse}
            onFallback={onStaffResponseFallback}
            locale={locale}
          />
          <ConnectedView target={data.target?.label ?? ''} onComplete={complete} locale={locale} />
        </>
      );
    case 'timeout':
    case 'failed':
      return (
        <>
          <ResultView
            outcome={data.state}
            onFallback={onFallback}
            locale={locale}
          />
          {/* ワンタップ満足度フィードバック (#320)。テナント設定でオフなら UI ごと出さない。 */}
          {feedback.enabled ? <SatisfactionFeedback onSubmit={feedback.onSubmit} locale={locale} /> : null}
        </>
      );
    case 'fallback':
      return <FallbackView locale={locale} />;
    case 'cancelled':
      return <EndView testid="completed" tone="info" title={tr('reception.cancelled')} locale={locale} />;
    case 'completed':
      return (
        <>
          <EndView
            testid="completed"
            tone="success"
            title={tr('reception.completedTitle')}
            lead={tr('reception.thanksLead')}
            locale={locale}
          />
          {/* 退館クレデンシャル (#342)。発行できた場合のみ QR / 短コード / 有効期限を提示する。 */}
          {checkoutCredential ? (
            <CheckoutCredentialPanel credential={checkoutCredential} locale={locale} />
          ) : null}
          {/* ワンタップ満足度フィードバック (#320)。テナント設定でオフなら UI ごと出さない。 */}
          {feedback.enabled ? <SatisfactionFeedback onSubmit={feedback.onSubmit} locale={locale} /> : null}
        </>
      );
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
/** クイックアクション intent → 辞書キー（label/desc）。多言語表示に使う (#103)。 */
const QUICK_ACTION_I18N: Record<QuickActionIntent, { label: MessageKey; desc: MessageKey }> = {
  callStaff: { label: 'kiosk.action.callStaff.label', desc: 'kiosk.action.callStaff.desc' },
  checkin: { label: 'kiosk.action.checkin.label', desc: 'kiosk.action.checkin.desc' },
  department: { label: 'kiosk.action.department.label', desc: 'kiosk.action.department.desc' },
  delivery: { label: 'kiosk.action.delivery.label', desc: 'kiosk.action.delivery.desc' },
  other: { label: 'kiosk.action.other.label', desc: 'kiosk.action.other.desc' },
};

function IdleView({
  onQuickAction,
  guidance,
  vrmUrl,
  avatarFallbackUrl,
  motionUrl,
  locale,
  onLocaleChange,
  branding,
}: {
  onQuickAction: (action: QuickAction) => void;
  guidance: string;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  motionUrl?: string;
  locale: Locale;
  onLocaleChange: (next: Locale) => void;
  branding: BrandingSettings;
}) {
  const actions = quickActionsFor('idle');
  const tr = makeT(locale);
  // ja は管理設定で上書きできる案内文言（guidance）を使い、他言語は辞書の挨拶＋安心情報を出す (#103 / #324)。
  // リードは主指示（見出しの「ご用件をお選びください」）を重ねず、挨拶＋「タッチだけで受付できる」
  // 安心情報に限定して二重指示を避ける (#324)。文の区切りは locale に合わせる（CJK は「。」、他は「. 」）。
  // 'ja-simple' は日本語の一種なので 'ja' と同じ区切りにする (#321)。
  const sentenceSep = locale === 'ja' || locale === 'zh' || locale === 'ja-simple' ? '。' : '. ';
  const lead =
    locale === DEFAULT_LOCALE
      ? guidance
      : `${tr('welcome.title')}${sentenceSep}${tr('reception.idleReassure')}`;
  // 既存 testid との後方互換（再設計後もリンク切れにしない）。
  const legacyTestId: Partial<Record<QuickAction['intent'], string>> = {
    callStaff: 'start-reception',
    checkin: 'start-checkin',
  };
  const hasBrand = hasBrandingContent(branding);
  return (
    <div
      className={`screen__body kiosk-idle${hasBrand ? ' kiosk-idle--branded' : ''}`}
      data-testid="kiosk-idle"
    >
      {/* テナントのブランド（ロゴ/社名）。待機画面を「その会社の受付」に見せる (#88)。 */}
      {hasBrand ? (
        <div className="kiosk-brand" data-testid="kiosk-brand">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="kiosk-brand__logo" src={branding.logoUrl} alt={branding.companyName ?? ''} />
          ) : null}
          {branding.companyName ? <span className="kiosk-brand__name">{branding.companyName}</span> : null}
        </div>
      ) : null}
      {/*
        #123 アバター状態同期。AvatarGuide が screenState から発話/字幕/モーションを導出し、
        idle では「AI受付です…」の字幕で AI 受付であることを初期体験で明示する。音声は KioskFlow 側の
        案内読み上げ（SPEAK_PHRASES）と二重化しないよう、ここでは字幕のみ（ttsSettings 未指定）。
        VRM/静止画が無くても字幕・フォールバックテキストで内容を保証する。pointer-events:none で操作を妨げない。
      */}
      <div className="kiosk-idle__avatar" data-slot="avatar">
        <AvatarGuide
          className="kiosk-avatar-guide"
          screenState="idle"
          locale={locale}
          vrmUrl={vrmUrl}
          fallbackImageUrl={avatarFallbackUrl}
          defaultMotionUrl={motionUrl}
        />
      </div>
      <header className="kiosk-idle__head">
        <h1 className="screen__title">{tr('reception.purposePrompt')}</h1>
        <p className="screen__lead" data-testid="idle-guidance" lang={htmlLangFor(locale)}>
          {lead}
        </p>
        {/* 言語切替 (#103)。読めない言語でも自言語ラベルで選べる。 */}
        <LanguageSwitcher
          locale={locale}
          onChange={onLocaleChange}
          label={tr('welcome.chooseLanguage')}
        />
      </header>
      <div className="card-grid kiosk-quick-actions" data-testid="kiosk-quick-actions">
        {actions.map((action) => {
          const keys = QUICK_ACTION_I18N[action.intent];
          return (
            <button
              key={action.intent}
              type="button"
              className="card card--cta"
              data-testid={legacyTestId[action.intent] ?? action.testId}
              data-intent={action.intent}
              lang={htmlLangFor(locale)}
              onClick={() => onQuickAction(action)}
            >
              <span className="card__icon" aria-hidden="true">
                {quickActionIcon(action.intent)}
              </span>
              {tr(keys.label)}
              <span className="card__sub">{tr(keys.desc)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PurposeView({
  onSelect,
  locale,
}: {
  onSelect: (p: ReceptionPurposeId) => void;
  locale: Locale;
}) {
  // 「最初に戻る/キャンセル」は常設の逃げ道バー（EscapeHatchBar）に一本化したため、ここには置かない
  // （画面内フッターと逃げ道バーで「最初に戻る」が二重表示になる問題を解消, #121）。
  const tr = makeT(locale);
  // 待機の見出し（purposePrompt）と同一文言だと「担当者を呼ぶ」→ 目的選択で同じ質問が二重に見える
  // ため、ここは「種類の絞り込み」として purposeDetailPrompt を出す (#324-2)。
  // カード自体も待機カードと同じアイコン＋説明を持たせて視覚語彙を統一する (#324-3)。
  return (
    <>
      <h1 className="screen__title">{tr('reception.purposeDetailPrompt')}</h1>
      <div className="screen__body">
        <div className="card-grid">
          {RECEPTION_PURPOSES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="card card--cta"
              data-testid={`purpose-${p.id}`}
              lang={htmlLangFor(locale)}
              onClick={() => onSelect(p.id)}
            >
              <span className="card__icon" aria-hidden="true">
                {purposeIcon(p.id)}
              </span>
              {tr(`reception.purpose.${p.id}` as MessageKey)}
              <span className="card__sub">{tr(`reception.purpose.${p.id}.desc` as MessageKey)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function TargetView({
  directory,
  sttEnabled,
  onSelect,
  onVoiceUse,
  onSearchQuery,
  onRequestChat,
  locale,
}: {
  directory: Directory;
  sttEnabled: boolean;
  onSelect: (t: Target) => void;
  /** 音声候補が採用されたことを体験メトリクスへ通知する (issue #319)。 */
  onVoiceUse?: () => void;
  /** 検索実行のヒット有無を体験メトリクスへ通知する（クエリ文字列は渡さない, issue #322）。 */
  onSearchQuery?: (hasHit: boolean) => void;
  /** 0 件時の「チャットで相談する」から Chat-assisted ドロワーを開く (issue #322)。 */
  onRequestChat?: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const [query, setQuery] = useState('');
  // 音声認識の候補。タップで検索欄に反映し、来訪者の確認後に選択する（即時呼び出ししない）(issue #5)。
  const [sttCandidates, setSttCandidates] = useState<string[]>([]);
  const [sttListening, setSttListening] = useState(false);
  const isSearching = query.trim() !== '';
  // 未入力時は従来どおり全件表示。入力時は tier 付きスコアリング検索（ローマ字/表記ゆれ/1 文字
  // typo に寛容, issue #322）を行い、exact/prefix/contains → fuzzy（もしかして）の順で並べる。
  const scored = useMemo(
    () => (isSearching ? searchStaffScored(directory.staff, query) : []),
    [directory.staff, query, isSearching],
  );
  const results = isSearching ? scored.map((m) => m.item) : directory.staff;
  const tierById = useMemo(() => new Map(scored.map((m) => [m.item.id, m.tier])), [scored]);
  const departments = directory.departments;
  const departmentSectionRef = useRef<HTMLDivElement>(null);
  const hasNoResults = isSearching && results.length === 0;

  // 検索実行のヒット有無を体験メトリクスへ記録する（クエリ文字列自体は保持しない, issue #322）。
  // 打鍵のたびに数えないよう軽くデバウンスする。
  useEffect(() => {
    if (!isSearching) return;
    const timer = setTimeout(() => {
      onSearchQuery?.(results.length > 0);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- results は query/directory から導出済み
  }, [query, isSearching]);

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
      <h1 className="screen__title">{tr('reception.targetPrompt')}</h1>
      <div className="screen__body">
        <div className="field">
          <label className="field__label" htmlFor="staff-search" lang={htmlLangFor(locale)}>
            {tr('reception.searchStaff')}
          </label>
          <input
            id="staff-search"
            className="input"
            data-testid="staff-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr('reception.searchPlaceholder')}
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
              {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
            </button>
            {sttCandidates.length > 0 ? (
              <>
                <p className="card__sub" data-testid="stt-hint" lang={htmlLangFor(locale)}>
                  {tr('reception.voiceHint')}
                </p>
                <div className="card-grid" data-testid="stt-candidates">
                  {sttCandidates.map((c, i) => (
                    <button
                      key={`${c}-${i}`}
                      type="button"
                      className="card"
                      data-testid={`stt-candidate-${i}`}
                      // 候補は検索欄に反映するのみ。担当者選択・呼び出しは行わない (issue #5)。
                      // 音声候補の採用を主入力手段=音声として体験メトリクスに記録する (issue #319)。
                      onClick={() => {
                        onVoiceUse?.();
                        setQuery(c);
                      }}
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
                  {tierById.get(s.id) === 'fuzzy' ? (
                    // あいまい一致（1 文字 typo・表記ゆれ由来）は「もしかして」と明示し、
                    // 完全一致/前方一致と混同させない (issue #322 AC2)。
                    <span className="card__badge" data-testid={`staff-${s.id}-maybe`} lang={htmlLangFor(locale)}>
                      {tr('reception.searchMaybeMatch')}
                    </span>
                  ) : null}
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
                  <span className="card__sub" data-testid={`staff-${s.id}-absent`} lang={htmlLangFor(locale)}>
                    {tr('reception.staffAbsent')}
                  </span>
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="notice notice--warning" data-testid="staff-empty" lang={htmlLangFor(locale)}>
            <p style={{ margin: 0 }}>{tr('reception.staffNotFound')}</p>
          </div>
        )}

        {hasNoResults ? (
          // 0 件で行き止まりにしない：部署一覧・チャット相談への次の一手を必ず提示する
          // (issue #322 AC3)。文言は i18n（dictionary.ts の privacy.* 隣接キー）。
          <div className="notice notice--warning" data-testid="search-no-results-guidance" lang={htmlLangFor(locale)}>
            <p style={{ margin: 0 }}>{tr('reception.searchNoResultsGuidance')}</p>
            <div className="card-grid" style={{ marginTop: 'var(--space-md)' }}>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="search-empty-department-cta"
                onClick={() =>
                  departmentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {tr('reception.byDepartment')}
              </button>
              {onRequestChat ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  data-testid="search-empty-chat-cta"
                  onClick={() => onRequestChat()}
                >
                  {tr('reception.searchNoResultsChatCta')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div ref={departmentSectionRef}>
          <h2 style={{ fontSize: 'var(--font-lg)', margin: 0 }} lang={htmlLangFor(locale)}>{tr('reception.byDepartment')}</h2>
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
      </div>
      {/*
        後退（戻る/最初に戻る）は常設の逃げ道バー（EscapeHatchBar, sticky）へ一本化した (#325)。
        担当者一覧は長くなり得るが、バーは画面下端に常時可視なので戻る導線は失われない。
      */}
    </>
  );
}

function VisitorInfoView({
  initial,
  onSubmit,
  locale,
  privacyNoticeOverride,
  presenceCameraEnabled,
}: {
  initial?: VisitorInfo;
  onSubmit: (v: VisitorInfo) => void;
  locale: Locale;
  privacyNoticeOverride: string | undefined;
  presenceCameraEnabled: boolean;
}) {
  const tr = makeT(locale);
  const [name, setName] = useState(initial?.name ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const valid = name.trim().length > 0;

  return (
    <>
      <h1 className="screen__title">{tr('reception.visitorInfoPrompt')}</h1>
      <div className="screen__body">
        {/* 用途・保存有無・保持期間・問い合わせ先を入力前に明示する (issue #314)。 */}
        <PrivacyNotice
          locale={locale}
          overrideSummary={privacyNoticeOverride}
          presenceCameraEnabled={presenceCameraEnabled}
        />
        <div className="field">
          <label className="field__label" htmlFor="visitor-name" lang={htmlLangFor(locale)}>
            {tr('reception.requiredLabel', { field: tr('reception.fieldName') })}
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
          <label className="field__label" htmlFor="visitor-company" lang={htmlLangFor(locale)}>
            {tr('reception.optionalLabel', { field: tr('reception.fieldCompany') })}
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
          <label className="field__label" htmlFor="visitor-note" lang={htmlLangFor(locale)}>
            {tr('reception.optionalLabel', { field: tr('reception.fieldNote') })}
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
      {/* 後退（戻る/最初に戻る）は逃げ道バーへ一本化 (#325)。フッターは前進の主 CTA のみ。 */}
      <div className="screen__footer">
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
          {tr('reception.proceedConfirm')}
        </button>
      </div>
    </>
  );
}

function ConfirmView({
  data,
  onConfirm,
  onBack,
  locale,
}: {
  data: FlowData;
  onConfirm: () => void;
  onBack: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const purposeLabel = data.purpose ? tr(`reception.purpose.${data.purpose}` as MessageKey) : '-';
  return (
    <>
      <h1 className="screen__title">{tr('reception.confirm')}</h1>
      <div className="screen__body">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-md)', fontSize: 'var(--font-lg)' }}>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldPurpose')}</dt>
          <dd style={{ margin: 0 }}>{purposeLabel}</dd>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldTarget')}</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-target">
            {data.target?.label}
          </dd>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldName')}</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-name">
            {data.visitor?.name}
          </dd>
          {data.visitor?.company ? (
            <>
              <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldCompany')}</dt>
              <dd style={{ margin: 0 }}>{data.visitor.company}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="confirm-back" onClick={onBack}>
          {tr('reception.editInfo')}
        </button>
        <button type="button" className="btn btn--primary" data-testid="confirm-call" onClick={onConfirm}>
          {tr('reception.callWithThis')}
        </button>
      </div>
    </>
  );
}

/**
 * 担当者の応答アクションを来訪者向けに表示するバナー (issue #99)。
 * 応答がなければ何も描画しない（呼び出し中の通常表示を妨げない）。
 * 拒否・別チャネル誘導（offersFallback）のときは代替導線を併記する。
 *
 * (#323 AC2) 応答内容を主役として大きく表示する（`staff-response-banner--prominent`）。
 * 呼び出し側が `key={response.respondedAt}` を付けて呼ぶことで、新しい応答が届くたびに
 * 本コンポーネントが再マウントされ入場アニメ（`kiosk-rise`）が再生される＝「応答が届いた瞬間」を
 * 視覚的に明確化する。`kioskStatus === 'waiting'`（「5分お待ちください」）のときは、目安の
 * 再案内（reception.staffResponseWaitReguidance）を併記する。
 */
function StaffResponseBanner({
  response,
  onFallback,
  locale,
}: {
  response: StaffResponseResult | null;
  onFallback: () => void;
  locale: Locale;
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
      className="staff-response-banner staff-response-banner--prominent"
      data-testid="staff-response-banner"
      data-status={response.kioskStatus}
      style={{ marginBottom: 'var(--space-md)' }}
    >
      <div className={`${noticeClass} staff-response-banner__message`} role="status" data-testid="staff-response-message">
        {response.visitorMessage}
      </div>
      {response.kioskStatus === 'waiting' ? (
        <p className="staff-response-banner__reguidance" data-testid="staff-response-reguidance" lang={htmlLangFor(locale)}>
          {makeT(locale)('reception.staffResponseWaitReguidance')}
        </p>
      ) : null}
      {response.offersFallback ? (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="staff-response-fallback"
          onClick={onFallback}
          style={{ marginTop: 'var(--space-sm)' }}
          lang={htmlLangFor(locale)}
        >
          {makeT(locale)('reception.toDesk')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 結果/待ち画面のトーンアイコン (#326 L1)。装飾のみ（ラベルはメッセージ側が持つ）で
 * aria-hidden にする。currentColor で `.result-panel--<tone>` の色を継承する。
 */
function ResultToneIcon({ tone }: { tone: ResultTone }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
  switch (tone) {
    case 'success':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.5 2.5 2.5L16 9.5" />
        </svg>
      );
    case 'danger':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...svgProps}>
          <path d="M12 3.5 21.5 20h-19L12 3.5z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      );
    case 'info':
    default:
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M12 11v5" />
        </svg>
      );
  }
}

/**
 * 結果/待ち画面の共通レイアウト (#326 L1)。
 *
 * 呼び出し中・結果（接続/タイムアウト/失敗/代替導線）・完了/キャンセルは、これまで
 * 「通知ピルが画面中央にぽつんと浮く」だけで死空間が大きかった。状態アイコン＋メッセージ＋
 * 次の一手（あれば）を 1 枚のパネル（.result-panel）へ凝集し、fold 内で完結させる。
 * トーンは `resultToneForState` が状態から一意に導出する（真実源はそちら）。
 * 後退（戻る/最初に戻る）は逃げ道バーへ一本化済み (#325) のため、ここでは前進系の
 * アクションのみを扱う。
 */
function ResultPanel({
  tone,
  testId,
  title,
  message,
  action,
  locale,
  panelDataAttrs,
  children,
}: {
  tone: ResultTone;
  /** パネル自体の testid。既存 e2e の可視性チェックはこのまま通る。 */
  testId: string;
  title?: string;
  message?: string;
  action?: {
    label: string;
    onClick: () => void;
    testId: string;
    variant?: 'primary' | 'secondary';
    /** 実行中に二度押しを防ぐため無効化する（例: 受付完了ボタンの busy ガード, #342）。 */
    disabled?: boolean;
  };
  locale: Locale;
  /** パネルの root div へ追加する data-* 属性（例: 呼び出し段階 #323）。 */
  panelDataAttrs?: Record<string, string>;
  /** アイコンとタイトルの間に差し込む追加要素（例: 経過インジケータ, #323）。 */
  children?: React.ReactNode;
}) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className={`result-panel result-panel--${tone}`} data-testid={testId} lang={htmlLangFor(locale)} {...panelDataAttrs}>
        <span className="result-panel__icon">
          <ResultToneIcon tone={tone} />
        </span>
        {children}
        {title ? <h1 className="result-panel__title">{title}</h1> : null}
        {message ? <p className="result-panel__message">{message}</p> : null}
        {action ? (
          <div className="result-panel__actions">
            <button
              type="button"
              className={`btn btn--${action.variant ?? 'primary'}`}
              data-testid={action.testId}
              onClick={action.onClick}
              disabled={action.disabled}
              lang={htmlLangFor(locale)}
            >
              {action.label}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 呼び出し中の待ち画面 (issue #323)。
 *
 * 「進んでいるのか固まっているのか分からない」を解消するため、常時アニメーションする
 * 経過インジケータ（`calling-pulse`。正確な秒数より「動いている」ことの伝達を優先）と、
 * 経過段階（dialing/waiting/preTimeoutNotice、UI 層のタイマー派生。state.ts は不変）に応じた
 * 文言の切り替えを行う。`stage` は KioskFlow の `useCallingStage` が算出する。
 */
function CallingView({
  target,
  locale,
  stage,
  textOverride,
}: {
  target: string;
  locale: Locale;
  /** 呼び出し中の経過段階 (#323)。UI 層のタイマー派生。 */
  stage: CallingStage;
  /** テナントの案内文言上書き（ja のみ, #28）。未設定は i18n 既定文言。 */
  textOverride: { waiting?: string; notice?: string };
}) {
  const tr = makeT(locale);
  return (
    <ResultPanel
      tone={stage === 'preTimeoutNotice' ? 'warning' : resultToneForState('calling')}
      testId="calling"
      title={tr('reception.callingTitle')}
      message={callingStageMessage(stage, target, locale, textOverride)}
      locale={locale}
      panelDataAttrs={{ 'data-calling-stage': stage }}
    >
      {/* 常時動く経過インジケータ。「動いている」ことの伝達を優先し、正確な秒数は示さない。
          prefers-reduced-motion は globals.css の全体ルールで自動的に抑制される。 */}
      <span className="calling-pulse" data-testid="calling-pulse" aria-hidden="true">
        <span className="calling-pulse__dot" />
        <span className="calling-pulse__dot" />
        <span className="calling-pulse__dot" />
      </span>
    </ResultPanel>
  );
}

function ConnectedView({
  target,
  onComplete,
  locale,
}: {
  target: string;
  onComplete: () => void | Promise<void>;
  locale: Locale;
}) {
  const tr = makeT(locale);
  // 二度押しガード: 完了は在館記録の起票 API を伴い、サーバの冪等チェックは check-then-act で
  // 非原子的（#342 レビュー指摘）。実運用の二重タップ由来の重複起票を単一 in-flight に絞るため、
  // 実行中はボタンを無効化して onComplete を一度しか発火させない（KioskAuthorize.busy と同型）。
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onComplete();
    } finally {
      setBusy(false);
    }
  };
  // connected は「担当者がまいります／操作は不要です」を message で明示し、終了操作は任意にする (#324-5)。
  // 主 CTA（primary）で終了を促すと「押さないと進まない」と誤解させるため、secondary の任意アクションにする。
  // 「操作不要」の案内と挙動を一致させるため、connected は無操作タイムアウトで待機へ自動復帰する
  // （INACTIVITY_RESET_STATES に connected を追加, #324）。明示的に今すぐ終えたい来訪者のため操作は残す。
  return (
    <ResultPanel
      tone={resultToneForState('connected')}
      testId="result-connected"
      message={tr('reception.connectedBody', { target })}
      action={{
        label: tr('reception.finishReception'),
        onClick: () => void finish(),
        testId: 'complete',
        variant: 'secondary',
        disabled: busy,
      }}
      locale={locale}
    />
  );
}

function ResultView({
  outcome,
  onFallback,
  locale,
}: {
  outcome: 'timeout' | 'failed';
  onFallback: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const message = tr(outcome === 'timeout' ? 'reception.timeoutBody' : 'reception.failedBody');
  // 後退（最初に戻る）は逃げ道バーへ一本化 (#325)。コンテンツ側は前進の主 CTA（代替の連絡先へ＝
  // useFallback）のみ。以前あった result-reset（最初に戻る）はバーの escape-reset と重複するため撤去。
  return (
    <ResultPanel
      tone={resultToneForState(outcome)}
      testId={`result-${outcome}`}
      message={message}
      action={{ label: tr('reception.altContact'), onClick: onFallback, testId: 'use-fallback', variant: 'secondary' }}
      locale={locale}
    />
  );
}

function FallbackView({ locale }: { locale: Locale }) {
  const tr = makeT(locale);
  // 後退（最初に戻る）は逃げ道バー（escape-reset）へ一本化 (#325)。以前あった fallback-reset は
  // バーと重複するため撤去し、コンテンツは代替案内メッセージのみにする。
  return (
    <ResultPanel
      tone={resultToneForState('fallback')}
      testId="fallback"
      message={tr('reception.fallbackBody')}
      locale={locale}
    />
  );
}

/** ワンタップ満足度評価の表示順・絵文字・testid・aria-label キー (issue #320)。 */
const SATISFACTION_RATINGS: readonly { rating: SatisfactionRating; icon: string; labelKey: MessageKey }[] = [
  { rating: 'happy', icon: '😊', labelKey: 'reception.feedback.happy' },
  { rating: 'neutral', icon: '😐', labelKey: 'reception.feedback.neutral' },
  { rating: 'unhappy', icon: '😞', labelKey: 'reception.feedback.unhappy' },
];

/** 満足度評価に添える定型理由チップの表示順・testid・辞書キー (issue #320)。自由記述は無い。 */
const FEEDBACK_REASON_CHIPS: readonly { code: FeedbackReasonCode; labelKey: MessageKey }[] = [
  { code: 'waitTooLong', labelKey: 'reception.feedback.reason.waitTooLong' },
  { code: 'hardToOperate', labelKey: 'reception.feedback.reason.hardToOperate' },
  { code: 'staffUnavailable', labelKey: 'reception.feedback.reason.staffUnavailable' },
  { code: 'other', labelKey: 'reception.feedback.reason.other' },
];

/**
 * 終端画面（完了/未応答/失敗）のワンタップ満足度フィードバック (issue #320)。
 *
 * AC「1 タップで評価でき、直後に通常の自動復帰が動く」: 絵文字ボタンを 1 回タップした時点で
 * 評価を確定・送信する（送信は fire-and-forget。以降の待機/確認ステップは無い）。理由チップは
 * 評価後に追加で選べる任意項目で、選択のたびに（評価値 + そこまでの選択）を再送して上書きする。
 * 自由記述欄は存在しない（コード化された列挙のみ、#105 PII 最小化）。
 *
 * 評価しないまま放置しても何も送信されない（AC「評価せず放置しても体験が変わらない」）。
 * 親（KioskFlow）は画面遷移ごとに `key={data.state}` で本コンポーネントを再マウントするため、
 * 内部状態（rating/reasons）は終端画面に入るたびに自然にリセットされる。
 */
function SatisfactionFeedback({
  onSubmit,
  locale,
}: {
  onSubmit: (rating: SatisfactionRating, reasonCodes: FeedbackReasonCode[]) => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const [rating, setRating] = useState<SatisfactionRating | null>(null);
  const [reasons, setReasons] = useState<FeedbackReasonCode[]>([]);

  const pickRating = (next: SatisfactionRating) => {
    if (rating !== null) return; // 評価は 1 タップで確定（連打で上書きしない）
    setRating(next);
    onSubmit(next, []);
  };

  const toggleReason = (code: FeedbackReasonCode) => {
    if (rating === null) return;
    const next = reasons.includes(code) ? reasons.filter((c) => c !== code) : [...reasons, code];
    setReasons(next);
    onSubmit(rating, next);
  };

  return (
    <div className="satisfaction-feedback" data-testid="satisfaction-feedback" lang={htmlLangFor(locale)}>
      {rating === null ? (
        <>
          <p className="satisfaction-feedback__prompt">{tr('reception.feedback.prompt')}</p>
          <div
            className="satisfaction-feedback__ratings"
            role="group"
            aria-label={tr('reception.feedback.prompt')}
          >
            {SATISFACTION_RATINGS.map(({ rating: r, icon, labelKey }) => (
              <button
                key={r}
                type="button"
                className="satisfaction-feedback__rating-btn"
                data-testid={`satisfaction-${r}`}
                aria-label={tr(labelKey)}
                onClick={() => pickRating(r)}
              >
                <span aria-hidden="true">{icon}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="satisfaction-feedback__prompt" data-testid="satisfaction-feedback-thanks">
            {tr('reception.feedback.thanks')}
          </p>
          <p className="satisfaction-feedback__prompt">{tr('reception.feedback.reasonPrompt')}</p>
          <div
            className="satisfaction-feedback__reasons"
            role="group"
            aria-label={tr('reception.feedback.reasonPrompt')}
          >
            {FEEDBACK_REASON_CHIPS.map(({ code, labelKey }) => (
              <button
                key={code}
                type="button"
                className="satisfaction-feedback__reason-chip"
                data-testid={`satisfaction-reason-${code}`}
                aria-pressed={reasons.includes(code)}
                onClick={() => toggleReason(code)}
              >
                {tr(labelKey)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 無操作リセット直前のカウントダウン警告 (issue #125 UX, "don't surprise-expire")。
 * 突然のリセットで来訪者を驚かせず、プライバシーのために戻ることを予告し、続行手段を与える。
 */
function InactivityWarning({
  seconds,
  locale,
  onContinue,
}: {
  seconds: number;
  locale: Locale;
  onContinue: () => void;
}) {
  const tr = makeT(locale);
  return (
    <div
      className="inactivity-overlay"
      data-testid="inactivity-warning"
      role="alertdialog"
      aria-live="assertive"
      aria-label={tr('reception.inactivityTitle')}
      lang={htmlLangFor(locale)}
    >
      <div className="inactivity-overlay__panel">
        <h2 className="inactivity-overlay__title">{tr('reception.inactivityTitle')}</h2>
        <p className="inactivity-overlay__body">{tr('reception.inactivityBody')}</p>
        <p className="inactivity-overlay__count" data-testid="inactivity-countdown">
          {tr('reception.inactivityCountdown', { seconds })}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="inactivity-continue"
          onClick={onContinue}
        >
          {tr('reception.inactivityContinue')}
        </button>
      </div>
    </div>
  );
}

function EndView({
  testid,
  tone,
  title,
  lead,
  locale,
}: {
  testid: string;
  tone: ResultTone;
  title: string;
  lead?: string;
  locale: Locale;
}) {
  return <ResultPanel tone={tone} testId={testid} title={title} message={lead} locale={locale} />;
}

/**
 * 退館クレデンシャルの有効期限（ISO）を locale の時刻表記へ整形する (issue #342)。
 * 不正日付は空文字（表示を壊さない）。
 */
function formatExpiryTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * 受付完了画面の退館クレデンシャル提示 (issue #342)。
 *
 * 退館 QR（token を参照する URL のみを符号化。PII 非包含）・短い退館コード・有効期限・一行案内を出す。
 * 表示のみで、来訪者を待たせず（発行できた場合に後追い表示）、失敗時はそもそも描画しない
 * （呼び出し側が credential=null を渡す）。氏名・会社名は同居させない。token/code はログに出さない。
 * 色リテラルは使わずデザイントークン（--space-* 等）とデザインシステムのクラスに揃える。
 */
function CheckoutCredentialPanel({
  credential,
  locale,
}: {
  credential: CheckoutCredential;
  locale: Locale;
}) {
  const tr = makeT(locale);
  // origin はブラウザ由来（SSR 時は空。完了画面はクライアントで描画される）。
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const checkoutUrl = buildCheckoutUrl(origin, credential.token);
  const qrAlt = tr('checkout.credential.qrAlt');
  // QR 生成は render 中に走る。完了画面には error boundary が無いため、throw すると退館コード/
  // 案内まで巻き添えでクラッシュする。安全版で失敗時は null にし、QR を省いてコード/案内は残す。
  const qrSrc = safeCheckoutQrDataUrl(checkoutUrl, qrAlt);
  const expiry = formatExpiryTime(credential.expiresAt, locale);
  return (
    <section
      className="checkout-credential"
      data-testid="checkout-credential"
      lang={htmlLangFor(locale)}
      style={{
        marginTop: 'var(--space-lg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        textAlign: 'center',
      }}
    >
      <h2 className="screen__title" style={{ fontSize: 'var(--font-lg)' }}>
        {tr('checkout.credential.title')}
      </h2>
      <p className="screen__lead">{tr('checkout.credential.instruction')}</p>
      {qrSrc ? (
        <img
          src={qrSrc}
          alt={qrAlt}
          data-testid="checkout-credential-qr"
          width={200}
          height={200}
          style={{ width: 200, height: 200, maxWidth: '60vw' }}
        />
      ) : null}
      <p className="checkout-credential__code" style={{ fontSize: 'var(--font-lg)' }}>
        {tr('checkout.credential.codeLabel')}:{' '}
        <strong data-testid="checkout-credential-code" style={{ letterSpacing: '0.15em' }}>
          {credential.code}
        </strong>
      </p>
      {expiry ? (
        <p className="screen__lead" data-testid="checkout-credential-expiry">
          {tr('checkout.credential.expiresAt', { time: expiry })}
        </p>
      ) : null}
    </section>
  );
}
