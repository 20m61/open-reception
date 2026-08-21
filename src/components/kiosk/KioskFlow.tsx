'use client';

import { callFailureReasonFrom } from '@/domain/reception/call-failure';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  createLocalVoiceSessionFactory,
  shouldUseLocalVoiceOrchestrator,
} from '@/lib/voice-session/local-mode';
import type {
  FeedbackReasonCode,
  SatisfactionRating,
} from '@/domain/reception/log';
import {
  shouldResetOnInactivity,
  type ReceptionState,
} from '@/domain/reception/state';
import {
  motionKeyForState,
  resolveMotionUrl,
} from '@/domain/motion/types';
import {
  InactivityWarning,
  PrivacyNotice,
  callingStageMessage,
  renderScreen,
} from './reception-screens';
import {
  INITIAL,
  reducer,
  type Action,
  type CheckoutCredential,
} from './flow-state';
import {
  primeSpeech,
  speak,
} from './speech';
import {
  AvatarGuide,
} from './avatar/AvatarGuide';
import type {
  AvatarGuidanceOverride,
} from './avatar/guidance';
import {
  LanguageSwitcher,
} from './LanguageSwitcher';
import {
  makeT,
  DEFAULT_LOCALE,
  htmlLangFor,
  type Locale,
} from '@/lib/i18n';
import {
  LOCALE_LANGUAGE_CODE,
} from '@/lib/voice/locale-voice';
import {
  AccessibilityMenu,
} from './AccessibilityMenu';
import {
  DEFAULT_A11Y_MODE_STATE,
  clampA11yModeState,
  type FontScale,
} from '@/domain/kiosk/a11y-modes';
import {
  normalizeAccentColor,
} from '@/domain/branding/types';
import {
  KioskCallView,
} from './KioskCallView';
import dynamic from 'next/dynamic';

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

import {
  useStaffResponse,
  type ReceptionStatusPoll,
} from './useStaffResponse';
import {
  PurposeSelector,
} from './custom-flow/PurposeSelector';
import {
  VisitorInfoForm,
} from './custom-flow/VisitorInfoForm';
import type {
  KioskFlow as KioskCustomFlow,
  FlowFieldValues,
} from './custom-flow/types';
import {
  SignageDisplay,
} from './signage/SignageDisplay';
import {
  usePresenceCamera,
} from './usePresenceCamera';
import {
  useKioskLayout,
} from './useKioskLayout';
import {
  flowValuesToVisitorInfo,
  purposeIdForFlow,
  resolveKioskGate,
  shouldShowSignage,
  shouldUseCustomFlow,
} from './integration';
import type {
  PresenceCameraStatus,
} from './usePresenceCamera';
import {
  resolveKioskMode,
} from '@/domain/kiosk/mode';
import {
  INACTIVITY_WARNING_MS,
  resolveInactivityLimitMs,
} from '@/domain/kiosk/inactivity';
import {
  operatingStateOf,
  type KioskOperatingStatus,
} from '@/domain/kiosk/operating-status';
import {
  OutOfHoursView,
} from './OutOfHoursView';
import {
  type SttAdapterFactory,
} from './stt-adapter';
import {
  VoiceSessionLayer,
} from './VoiceSessionLayer';
import {
  voiceCandidateToTarget,
} from './voice-target-binding';
import type {
  OnResolved,
  VoiceSessionFactory,
} from '@/lib/voice-session/kiosk-binding';
import {
  debugScannerFromSearch,
} from './qr-injection';
import type {
  QrScanner,
} from '@/domain/checkin/scanner';
import {
  parseCallStages,
  type CallStage,
} from '@/domain/kiosk/call-stages';
import {
  isVisitorExit,
  shouldCancelOnServer,
} from '@/domain/reception/leave-calling';
import {
  escapeHatchesFor,
} from './quick-actions';
import { EscapeBar } from './EscapeBar';
import type {
  TurnAnswerView,
  TurnHandoffView,
} from './conversation-turn';
import {
  isElementVisible,
  persistentRegionProps,
} from './persistent-regions';
import {
  deriveAvatarPresence,
  deriveChatAvailability,
  type ReceptionAction,
} from '@/domain/reception/ui-contract';
import type {
  KioskLayout,
} from './layout';
import {
  KioskChatDrawer,
} from './KioskChatDrawer';
import Link from 'next/link';
import {
  useExperienceMetrics,
} from './useExperienceMetrics';
import {
  clampCallingStageThresholds,
  deriveCallingStage,
  timeoutDispatchDelayMs,
  type CallingStage,
  type CallingStageThresholds,
} from '@/domain/reception/calling-experience';
import { shouldOpenVideoView } from '@/domain/reception/call-medium';
import {
  CALL_STATUS_POLL_INTERVAL_MS,
  CALL_STATUS_POLL_MAX_MS,
  decidePollAction,
} from '@/domain/reception/call-poll';
import {
  useKioskConfiguration,
} from './useKioskConfiguration';
import {
  useKioskDeviceStatus,
} from './useKioskDeviceStatus';



/** 待機画面リードの ja 既定文言（テナント上書きが無いとき, #324）。i18n 移行は #327。 */
const DEFAULT_IDLE_GUIDANCE = 'ようこそ。タッチ操作だけで受付できます。';

/** 完了・キャンセル後に待機画面へ自動復帰するまでの時間。 */
const AUTO_RESET_MS = 6000;

// 無操作リセットの上限と警告時間は `src/domain/kiosk/inactivity.ts` の純ロジックに集約する
// （E2E 上書き `?inactivityMs=` / `?connectedInactivityMs=` の解決を含む）。

/**
 * 縦向き(ipad-portrait)でアバターコンパニオンを表示する状態 (#361 / 旧 #123)。
 *
 * #361 は「選択/入力/確認画面でもアバターとの対話を継続する」意図反転を導入したが、縦向きは
 * 操作が下部に密集し既存プロファイルを壊しやすい。よって縦向きでは従来どおり中央寄せで余白の
 * あるステータス画面（呼び出し中/通話/結果/完了/中止）に限定し、控えめ表示を維持する。
 * 横向き(ipad-landscape/large-display)は 35%/65% のレール構成で全受付ステップに継続表示する
 * （下記 showAvatarCompanion 参照）。表示状態の意味論的真実源は ui-contract の
 * deriveAvatarPresence（横縦非依存）で、ここはレイアウト別の描画ゲートに限る。
 */
const PORTRAIT_COMPANION_STATES: ReadonlySet<ReceptionState> = new Set([
  'calling',
  'connected',
  'timeout',
  'failed',
  'fallback',
  'completed',
  'cancelled',
]);

/**
 * その状態・レイアウトでアバターコンパニオンを描画するか (#361)。
 *  - 待機(idle)は IdleView がヒーロー(presence='primary')として大きく出すため companion は不要。
 *  - 縦向きは PORTRAIT_COMPANION_STATES に限定（重なり回避・既存プロファイル維持）。
 *  - 横向き/大型は presence!=='primary' の全受付ステップで会話コンパニオンを継続する（意図反転）。
 */
function showAvatarCompanion(state: ReceptionState, layout: KioskLayout): boolean {
  if (deriveAvatarPresence(state) === 'primary') return false;
  if (layout === 'ipad-portrait') return PORTRAIT_COMPANION_STATES.has(state);
  return true;
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


// 音声経路（voice-target-binding.ts）とタッチ経路で同一の相手構造を使う（後勝ち規則の前提）。
/**
 * KioskFlow の外部注入点 (第6wave / #363 injection points・#367 の kiosk 受け口)。
 * すべて任意で、未指定時は従来どおり動作する（additive・既定挙動は不変）。
 * デモ再現・テスト・将来の実 provider 接続はこれらの受け口経由で行う。
 */
export type KioskFlowProps = {
  /**
   * 起動時の受付モード (#736 検証用)。既定は通常受付。
   *
   * demo-studio のシナリオは `initialMode: 'qr'` を宣言しているのに、**この受け口が無かった
   * ため配線されていなかった**。「QR 期限切れ」のシナリオを開いても通常受付で起動するので、
   * 運用者は手で「ほかのご用件 → QR で受付」と辿る必要があり、E2E からも踏めなかった。
   */
  initialMode?: 'normal' | 'checkin';
  /**
   * 営業状態 (#367)。'closed' かつ待機中のとき営業時間外表示へ切り替える。
   * 未指定は「判定不能」= fail-open（通常受付を止めない）。ServiceOperatingPolicy の
   * 本評価は #367 で行い、その結果をここへ注入する。
   */
  operatingStatus?: KioskOperatingStatus;
  /**
   * 音声認識(STT)アダプタの生成ファクトリ (#370)。未指定は現行 MockSttAdapter（無変更動作）。
   * 将来の StreamingSttProvider などは中立 interface のこの受け口で接続する（直接 import しない）。
   */
  sttAdapterFactory?: SttAdapterFactory;
  /**
   * 音声対話セッションの注入 (#364)。未指定は従来どおりタッチ専用（音声 UI を一切マウントしない
   * = 完全な無変更動作）。指定時のみ音声対話 UI（字幕・復唱確認・barge-in インジケータ・タッチ縮退
   * 案内）を有効化する。synthetic（demo-studio 再現/テスト）でも 実 orchestrator wrapper でも、
   * `src/lib/voice-session/kiosk-binding.ts` の中立 factory を差し込む（直接 new しない）。
   */
  voiceSession?: VoiceSessionFactory;
  /**
   * QR スキャナの注入 (#363)。CheckinFlow へ透過する。未指定でも `?debugScanPayload=` があれば
   * カメラ無しのデバッグ用スキャナを使う。いずれも無ければ実カメラ（CameraQrScanner）のまま。
   */
  qrScanner?: QrScanner;
};

/**
 * 端末が待つのをやめたことをサーバへ伝える (#743)。
 *
 * 🔴 **応答を待たない・失敗しても画面を止めない。** 来訪者にできることは無く、
 * 画面が「呼び出し中」のまま固まる方が悪い。届かなければ取次は呼出予算で自然に終わる。
 */
function giveUpServerSide(receptionId: string): void {
  void fetch(`/api/kiosk/receptions/${receptionId}/give-up`, { method: 'POST' }).catch(() => {});
}

/**
 * 来訪者が**自分で**受付をやめたことをサーバへ伝える (#743)。
 *
 * `/give-up`（ポーリング上限の諦め）とは別の経路。あちらは `failed` + `client_timeout` で
 * 終端するが、こちらは来訪者の明示的な操作なので `cancelled` として残す
 * ──「呼び出せなかった」と「来訪者がやめた」を履歴上も混ぜない。
 *
 * 🔴 **応答を待たない・失敗しても画面を止めない**（`giveUpServerSide` と同じ理由）。
 * 届かなければ取次は呼出予算で自然に終わる。
 */
function cancelServerSide(receptionId: string): void {
  void fetch(`/api/kiosk/receptions/${receptionId}/cancel`, { method: 'POST' }).catch(() => {});
}

export function KioskFlow({
  initialMode = 'normal',
  operatingStatus,
  sttAdapterFactory,
  voiceSession,
  qrScanner,
}: KioskFlowProps = {}) {
  /*
   * 実 orchestrator のローカル起動 (#372 配線)。**既定はオフ。**
   *
   * `VoiceSessionOrchestrator`（ターン検出・barge-in・TTS duck/stop・VRM 同期）は実装も
   * テストも揃っているのに**本番呼び出し元がゼロ**で、一度も起動していなかった。実音声
   * （#369/#370）を繋ぐ前に、mock provider で通る経路を用意して実 UI で確かめられるようにする。
   *
   * 受付端末の音声挙動を変えるので `?voiceOrchestrator=1` を付けた端末だけ。明示注入
   * （`voiceSession` prop = demo-studio 等）があればそちらを優先する ── 呼び出し側の
   * 意図を URL が上書きしない。
   */
  const [localVoiceEnabled] = useState(() =>
    typeof window === 'undefined' ? false : shouldUseLocalVoiceOrchestrator(window.location.search),
  );
  const [data, dispatch] = useReducer(reducer, INITIAL);
  // onResolved 実結線 (#364): 音声で確定した相手候補を、タッチ経路と同一の SELECT_TARGET へ写像して
  // dispatch する。相手でない候補（purpose/other/なし）は null で無視。dispatch は useReducer 由来で
  // 安定なので、この callback は安定参照（音声セッションを不要に再起動させない）。競合は「後勝ち
  // （last-write-wins）」で解決する（voice-target-binding.ts の doc 参照）。selectingTarget 以外では
  // reducer が遷移を無視するため、音声確定が来ても現在の受付局面を壊さない。
  const handleVoiceResolved = useCallback<OnResolved>((candidate) => {
    const target = voiceCandidateToTarget(candidate);
    if (target) dispatch({ type: 'SELECT_TARGET', target });
  }, []);
  // 端末に適用する構成（ディレクトリ・音声・ブランド・アセット・モーション・フロー・サイネージ）は
  // `useKioskConfiguration` が所有する (#422 increment 2)。取得経路（実効構成の一括取得 / 個別 API）は
  // 移行フラグで選ばれ、ここからは見えない。名前は分離前と同じにして呼び出し側を変えない。
  const {
    directory,
    guidanceIdle: guidanceIdleOverride,
    privacyNoticeOverride,
    speakSettings,
    sttEnabled,
    backgroundUrl,
    branding,
    vrmUrl,
    avatarFallbackUrl,
    motions,
    customFlows,
    signageCount,
    feedbackEnabled,
    a11yEnabledModes,
    callingStageThresholdOverride: callingStageTenantOverride,
    callingStageTextOverride,
    report: configurationReport,
  } = useKioskConfiguration({
    // 受付が進行中の間は新しい版を適用しない（公開操作で来訪者の画面を入れ替えない, #420）。
    sessionActive: data.state !== 'idle',
  });
  // 待機画面リードの既定文言 (#324)。主指示（「ご用件をお選びください」）は見出し・アバター字幕が
  // 担うため、リードは挨拶＋安心情報（タッチだけで受付できる）のみにして指示を二重化しない。
  // ja は管理設定 (#28) で上書き可能。i18n 移行は #327（本ファイルは移行前の allowlist 対象）。
  const guidanceIdle = guidanceIdleOverride ?? DEFAULT_IDLE_GUIDANCE;
  // 受付の表示言語 (#103)。来訪者が待機画面の LanguageSwitcher で切替える（セッション内で保持）。
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  // 無操作リセット直前のカウントダウン警告（#125 UX, "don't surprise-expire"）。null=非表示。
  const [inactivitySeconds, setInactivitySeconds] = useState<number | null>(null);
  // 「続ける」ボタンから無操作タイマーを延長するための ref（実体は inactivity effect 内で設定）。
  const extendInactivityRef = useRef<() => void>(() => {});
  // 受付モード。idle から「QRで受付」を選ぶと checkin へ。完了/通常受付選択で normal へ戻す (issue #98)。
  const [mode, setMode] = useState<'normal' | 'checkin'>(initialMode);
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

  // 来訪者が目的選択で選んだカスタムフロー。null のときは既定フローのまま進む。
  const [selectedFlow, setSelectedFlow] = useState<KioskCustomFlow | null>(null);
  // 来訪者検知カメラの有効化トグル (issue #79)。既定 OFF（タップ起動が常に生きる）。
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  // ATTRACT オーバーレイの表示状態 (issue #362)。来訪検知が ATTRACT に達したときだけ
  // 画面が反応する（サイネージを軽く暗くし、挨拶と CTA を出す）。マイク・QR カメラ・
  // 受付セッションはここでは一切開始しない。受付開始は CTA タップの明示操作でのみ行う。
  const [attractVisible, setAttractVisible] = useState(false);
  // 受付完了時に発行された退館クレデンシャル (issue #342)。null=未発行/発行失敗（QR 非表示で継続）。
  // 完了画面に退館 QR / 短コード / 有効期限を提示する。idle 復帰で破棄する（次の来訪者へ持ち越さない）。
  const [checkoutCredential, setCheckoutCredential] = useState<CheckoutCredential | null>(null);
  // 来訪者が選べるアクセシビリティ支援モード (issue #321)。文字サイズ・ハイコントラスト・
  // 低位置レイアウトの現在値。既定は無支援（DEFAULT_A11Y_MODE_STATE）で、セッション終了・
  // 無操作リセットで idle 復帰時に既定へ戻す（次の来訪者へ持ち越さない、下記 idle effect 参照）。
  const [fontScale, setFontScale] = useState<FontScale>(DEFAULT_A11Y_MODE_STATE.fontScale);
  const [a11yHighContrast, setA11yHighContrast] = useState(DEFAULT_A11Y_MODE_STATE.highContrast);
  const [a11yLowReach, setA11yLowReach] = useState(DEFAULT_A11Y_MODE_STATE.lowReach);
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
  // E2E タイマー短縮用のクエリ上書き（`?callingStageMs=` 等、既存 `?inactivityMs=` の流儀）。
  // window 参照は SSR 不一致を避けるため effect 内でのみ行う。
  const [heartbeatQueryOverride, setHeartbeatQueryOverride] = useState<number | undefined>(
    undefined,
  );

  /**
   * 実 orchestrator のローカル起動 (#372 配線)。**既定はオフ。**
   *
   * mock STT はここで渡した候補から確定文を返すので、画面に居る担当者を渡す
   * （渡さないと解決できない候補ばかりになり、確認導線の検証にならない）。
   * 明示注入（`voiceSession` prop = demo-studio 等）が最優先 ── URL フラグが呼び出し側の
   * 意図を上書きしない。
   */
  const localVoiceSession = useMemo(() => {
    if (!localVoiceEnabled) return undefined;
    return createLocalVoiceSessionFactory(
      { staff: [], departments: [] },
      directory.staff.filter((s) => s.available).map((s) => s.displayName),
    );
  }, [localVoiceEnabled, directory.staff]);
  const effectiveVoiceSession = voiceSession ?? localVoiceSession;
  const [callingStageQueryOverride, setCallingStageQueryOverride] = useState<
    Partial<CallingStageThresholds>
  >({});
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const num = (key: string): number | undefined => {
      const v = Number(params.get(key));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    setHeartbeatQueryOverride(num('heartbeatMs'));
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

  // 端末の有効性・セッション保持・疎通は `useKioskDeviceStatus` が監視する (#422 increment 2)。
  // 失効（active=false）を検知したら受付中の個人情報を破棄して待機へ戻す (issue #30)。
  const handleDeviceRevoked = useCallback(() => {
    dispatch({ type: 'RESET' });
    setMode('normal');
  }, []);
  const { active, authorized, pinRequired, online, markAuthorized } = useKioskDeviceStatus({
    onRevoked: handleDeviceRevoked,
    // いま読み込んでいる版を heartbeat に相乗りさせて報告する (#420)。
    report: configurationReport,
    // E2E から通信断表示を検証するための周期短縮（既存 `?inactivityMs=` の流儀）。
    intervalMs: heartbeatQueryOverride,
  });


  // 受付体験メトリクスの計測 (issue #319 / #322) は `useExperienceMetrics` が所有する
  // (#422 increment 2)。PII を含まない所要/回数/入力手段のみを集計し、呼び出し作成時に
  // サーバへ同送する。計測は非破壊で受付挙動を変えない。
  const { markInputMethod, markVoiceInput, markSearchQuery, snapshotForCall } =
    useExperienceMetrics(data.state);

  // 検索 0 件時などから Chat-assisted ドロワーを外部から開く合図 (issue #322)。値の増加を
  // KioskChatDrawer 側の effect が検知して開く（ドロワーは自身の開閉状態を所有したまま）。
  const [chatOpenSignal, setChatOpenSignal] = useState(0);
  const requestChatOpen = useCallback(() => setChatOpenSignal((n) => n + 1), []);

  // Vonage（非同期）通話のとき、ビデオビューに渡す受付 ID。Mock 同期通話では null のまま。
  const [vonageCallId, setVonageCallId] = useState<string | null>(null);
  // 実 PSTN 発信中の受付 ID (#647)。ビデオと違いセッションが無いので、端末が
  // `/status` を取りに行って結果を確定させる（サーバ側の遅延確定に合流する）。
  const [pstnCallId, setPstnCallId] = useState<string | null>(null);
  // 取次段階 (#363 injection point 4)。`/call` 応答が `stages[]` を返したときだけ非空になり、
  // KioskCallView が段階表示する。旧形応答（stages 無し）は [] のまま（後方互換）。
  const [callStages, setCallStages] = useState<CallStage[]>([]);
  // QR スキャナの実効値 (#363)。注入 prop 最優先、無ければ `?debugScanPayload=` のデバッグ用
  // スキャナ、いずれも無ければ undefined（CheckinFlow が実カメラ CameraQrScanner を使う）。
  // デバッグ用スキャナはマウント時に一度だけ生成する（lazy initializer, window は client のみ）。
  const [debugQrScanner] = useState<QrScanner | undefined>(() =>
    typeof window !== 'undefined' ? debugScannerFromSearch(window.location.search) : undefined,
  );
  const effectiveQrScanner = qrScanner ?? debugQrScanner;

  // 呼び出し中になったら、セッション作成 → 呼び出しを実行して結果を反映する。
  useEffect(() => {
    if (data.state !== 'calling') return;
    let cancelled = false;
    setVonageCallId(null);
    setPstnCallId(null);
    setCallStages([]);

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
            experience: snapshotForCall(Date.now()),
          }),
        });
        if (!createRes.ok) {
          // サーバへは届いている（HTTP 応答が返った）ので server 扱い。
          if (!cancelled) dispatch({ type: 'CALL_FAILED', reason: 'server' });
          return;
        }
        const session = (await createRes.json()) as { id: string };
        // 受付 ID が確定した時点で状態機械へ載せる (#649)。`/call` の結果を待たないのは、
        // **呼び出し中**の担当者応答ポーリング（#99 `useStaffResponse`）が受付 ID を必要と
        // するため。結果と一緒にしか立たなかった頃は calling 中に 1 度も走っていなかった。
        // 状態は動かさない（calling のまま）。
        if (!cancelled) dispatch({ type: 'SESSION_CREATED', sessionId: session.id });
        const callRes = await fetch(`/api/kiosk/receptions/${session.id}/call`, { method: 'POST' });
        const result = (await callRes.json()) as {
          state: ReceptionState;
          vonageSessionId?: string | null;
          error?: string;
        };
        if (cancelled) return;
        // サーバが理由を返したなら、それを来訪者向けの理由へ写す (#736)。
        // 🔴 **`unrouted` だけを名指しで拾わない。** かつてここは `unrouted` の `if` が 1 つ
        // だけで、他の理由は状態分岐を素通りして最後の else で `server` に潰れていた。
        // そのため営業時間外（サーバは 409 と `reopenAt` を返している）の来訪者に
        // 「呼び出しに失敗しました」＋「代表窓口にお繋ぎします」という**果たせない約束**が
        // 出ていた。写像は契約（`callFailureReasonFrom`）に一本化する。
        const failureReason = callFailureReasonFrom(result.error);
        if (failureReason !== undefined) {
          dispatch({ type: 'CALL_FAILED', sessionId: session.id, reason: failureReason });
          return;
        }
        // 取次段階を後方互換で取り込む (#363)。旧形（stages 無し）は [] で、表示は増えない。
        setCallStages(parseCallStages(result));
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
        // 'calling' は非同期の待ち。**媒体が 2 つある** (#4 Inc D-2 項目 2):
        //   - ビデオ: セッションが確立済み。ビデオビューが応答/未応答を確定する
        //   - PSTN:  電話を鳴らした直後。セッションは無く、結果は provider webhook で届く
        // セッションが無いのにビデオビューを開くと、存在しないトークンを取りに行って失敗する。
        else if (shouldOpenVideoView(result)) setVonageCallId(session.id);
        else if (result.state === 'calling') {
          // PSTN 発信中は呼び出し中画面（段階的ケア #323）のまま、`/status` を取りに行く。
          setVonageCallId(null);
          setPstnCallId(session.id);
        }
        else dispatch({ type: 'CALL_FAILED', sessionId: session.id, reason: 'server' });
      } catch {
        // fetch が例外 = 端末からサーバへ到達できていない。呼び出しは行われていない。
        if (!cancelled) dispatch({ type: 'CALL_FAILED', reason: 'network' });
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

  // 実 PSTN 発信中は `/status` をポーリングして結果を確定させる (#647)。
  //
  // ビデオ経路（`vonageCallId`）はビデオビューが確定するのでここは走らない。判定は純関数
  // `decidePollAction` に閉じてあり、この effect はタイマーと fetch だけを持つ。
  //
  // 🔴 **経過時間で結果を作らない。** 状態を決めるのはサーバの応答だけ（権威はサーバ）。
  // 上限到達（`give_up`）は「判定できなかった」の表明で、未応答とは別物として
  // `contact_failed` へ倒す。
  //
  // 🔴 **`calling` の間だけ回す** (#652)。`pstnCallId` を null に戻すのは次に `calling` へ
  // 入ったときだけなので、`pstnCallId` だけを見ていると**来訪者が呼び出し中から抜けても
  // 最大 5 分（`CALL_STATUS_POLL_MAX_MS`）回り続ける**。抜ける経路は逃げ道バーの「最初に戻る」
  // (RESET)・CANCEL・担当者応答からの代替導線の 3 つあり、いずれも #652 以前から到達可能だった。
  // 状態機械が終端状態で `CALL_*` を不正遷移として無視するため**画面は壊れず、テストもゲートも
  // 緑のまま通る**種類の欠陥。`data.state` を条件と deps の両方に入れることで、抜けた時点で
  // cleanup が走ってタイマーが止まる（3 経路すべてが同時に閉じる）。
  // 🔴 **`give_up` 予算の起点は「PSTN 発信が確定した時刻」** (#652)。ポーリングのループは
  // 受付作成の時点から回っている（担当者応答と共有しているため）が、予算の起点をループ側に
  // 持たせると 1 往復ぶん早まって意味が変わる。ここで別に持つ。
  /**
   * 来訪者が自分で受付をやめる操作を、**サーバへ伝えてから** dispatch する (#743)。
   *
   * 🔴 **判断を 2 か所に書かない。** 抜ける入口は逃げ道バーとチャットドロワーの 2 つあり、
   * 片方に書くともう片方や 3 つ目の入口で黙って漏れる（#455 で「逃げ道バーを画面分岐の
   * 外へ出した」のと同じ理由）。判断そのものは `shouldCancelOnServer` が持つ。
   *
   * これが無いと、呼び出し中に「最初に戻る」を押した来訪者の受付は `calling` のまま残り、
   * **取次は hop 上限まで進んで社内の電話が鳴り続ける**。しかもポーリングは抜けた時点で
   * 止まる（#652）ので `/give-up` も呼ばれない ── 自分から抜けるほうが、放っておくより
   * 取次が長く走ることになる。
   */
  const leaveWithServer = (next: Action): void => {
    if (isVisitorExit(next.type) && shouldCancelOnServer(data.state, next.type, data.sessionId)) {
      cancelServerSide(data.sessionId!);
    }
    dispatch(next);
  };

  const pstnPollStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    pstnPollStartedAtRef.current = pstnCallId === null ? null : Date.now();
  }, [pstnCallId]);

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
    // connected（来訪待ち）は長めの上限を使う (#324)。E2E 上書きの解決も含めて純ロジックへ委譲する。
    const limit = resolveInactivityLimitMs({
      search: window.location.search,
      state: data.state,
    });
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
  //
  // **`/status` を叩くのはこの 1 本だけ** (#652)。実 PSTN の結果確定（#647）も同じ応答から
  // 導出する（`onPoll`）。かつては別々に 3 秒間隔で叩いており、サーバ側の `resolvePendingCall`
  // が丸ごと 2 倍走っていた。
  const pollResponseEnabled = data.state === 'calling' || data.state === 'connected';

  /**
   * 毎ポーリングの結果から実 PSTN の呼び出し結果を確定させる (#647 / #652)。
   *
   * 🔴 **経過時間で結果を作らない。** 状態を決めるのはサーバの応答だけ（権威はサーバ）。
   * 上限到達（`give_up`）は「判定できなかった」の表明で、未応答とは別物として
   * `contact_failed` へ倒す。
   *
   * 🔴 **`calling` の間だけ判断する。** 抜ける経路は逃げ道バーの「最初に戻る」(RESET)・
   * CANCEL・担当者応答からの代替導線の 3 つ。状態機械は終端状態で `CALL_*` を不正遷移として
   * 無視するので画面は壊れないが、来訪者が居なくなった後に結果を作らない。
   *
   * ビデオ経路（`vonageCallId`）はビデオビューが確定するので、ここは `pstnCallId` が
   * 立っているときだけ働く。
   */
  const handleStatusPoll = (result: ReceptionStatusPoll) => {
    const id = pstnCallId;
    const startedAt = pstnPollStartedAtRef.current;
    if (id === null || startedAt === null || data.state !== 'calling') return;
    const elapsedMs = Date.now() - startedAt;

    if (!result.ok) {
      // 単発の取得失敗では諦めない（電話は鳴り続けている）。上限に達したときだけ倒す。
      if (elapsedMs > CALL_STATUS_POLL_MAX_MS) {
        giveUpServerSide(id);
        dispatch({ type: 'CALL_FAILED', sessionId: id, reason: 'network' });
      }
      return;
    }

    const action = decidePollAction(result.status.state, elapsedMs);
    if (action.kind === 'resolved') {
      dispatch({ type: action.event, sessionId: id });
      return;
    }
    if (action.kind === 'give_up') {
      // 🔴 **画面を倒すだけにしない (#743)。** サーバ側の受付が `'calling'` のまま残ると
      // 取次は hop 上限まで進み続け、iPad は諦めたのに社内の電話が鳴り続ける。
      // 受付を終端させれば以降の hop は `decideRoutingStop` に弾かれる。
      giveUpServerSide(id);
      // 結果を断定しない。呼び出しを完了できなかった（contact_failed）として代替導線へ。
      dispatch({ type: 'CALL_FAILED', sessionId: id, reason: 'server' });
    }
  };

  const staffResponse = useStaffResponse(data.sessionId ?? null, {
    enabled: pollResponseEnabled,
    intervalMs: CALL_STATUS_POLL_INTERVAL_MS,
    onPoll: handleStatusPoll,
  });

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
  // 待機の入口カード (#422 inc5-b 増分 3b)。受付を開始し、用件の先取りがあれば添える。
  // 集合・並び順・用件の先取りは契約（`turnAnswersFor('idle')`）が決める。
  const startWithEntry = useCallback((answer: TurnAnswerView) => {
    primeSpeech();
    dispatch({ type: 'START', pendingPurpose: answer.presetPurpose });
  }, []);
  // 引き渡し入口 (#422 inc5-b 増分 3b)。**状態機械は進めず**別シェル（CheckinFlow）へ渡す。
  // 回答と関数を分けているのは、押したときに起こることが違うため（取り違えを型で防ぐ）。
  const handoffToShell = useCallback((handoff: TurnHandoffView) => {
    setMode(handoff.to);
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

  // 現在の表示レイヤー (issue #362)。PresenceState / ReceptionState を複製せず、既存の判定材料
  // （アクセスゲート・QR受付トグル・受付状態機械）から写像するだけの純関数に委譲する。
  const kioskMode = resolveKioskMode({
    gate: view,
    uiMode: mode,
    receptionState: data.state,
    // 営業状態注入 (#367)。未指定/open は operatingStateOf が undefined を返し fail-open。
    operatingStatus: operatingStateOf(operatingStatus),
  });

  // 来訪者検知カメラ (issue #79 / #362)。待機サイネージ表示中かつトグル ON のときだけ起動。
  // 未対応/拒否時は status='unavailable' に倒れ、タップ起動で完走する（非破壊）。
  // 受付中（kioskMode !== 'signage'）は presenceActive が false になり、カメラは完全に停止する
  // ＝ 受付中の presence 入力が現在セッションを壊さない (issue #362 AC)。
  const presenceActive = presenceEnabled && showSignage && kioskMode === 'signage';
  // ATTRACT 到達時は画面だけ反応させる（受付は開始しない）。受付開始は ATTRACT オーバーレイの
  // CTA タップ（=明示操作）でのみ startReception / checkin モード切替を呼ぶ。
  const handlePresenceAttract = useCallback(() => {
    setAttractVisible(true);
  }, []);
  const handlePresenceAttractTimeout = useCallback(() => {
    setAttractVisible(false);
  }, []);
  const presence = usePresenceCamera(presenceActive, handlePresenceAttract, {
    onAttractTimeout: handlePresenceAttractTimeout,
  });
  // presence カメラが停止したら（受付開始・トグル OFF・ゲート不可等）ATTRACT オーバーレイも
  // 必ず閉じる。カメラは止まったのにオーバーレイだけ残る/次回サイネージ復帰時に誤って
  // 出ている、という取り残しを防ぐ。
  useEffect(() => {
    if (!presenceActive) setAttractVisible(false);
  }, [presenceActive]);

  // ATTRACT オーバーレイ経由の受付開始・QR受付開始。presence の検知状態は presenceActive が
  // false になった時点でフック側が自動的に初期化する（次の来訪者を再検知できる）。
  const startReceptionFromAttract = useCallback(() => {
    setAttractVisible(false);
    startReception();
  }, [startReception]);
  const startCheckinFromAttract = useCallback(() => {
    setAttractVisible(false);
    setMode('checkin');
  }, []);

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
      // アバターの在り方（primary/companion/minimal）。#361 の会話継続レイアウトを CSS が消費する。
      // 横向きの選択/入力/確認ではアバターをレール(companion)として並置し対話の連続性を保つ。
      data-kiosk-presence={view === 'ready' ? deriveAvatarPresence(data.state) : undefined}
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
      {/*
        音声対話 UI レイヤ (#364 / #361)。voiceSession 注入時のみマウントする opt-in オーバーレイ。
        既存の 35%/65% レール（アバター/操作）を壊さない画面下部の重ね描画で、字幕・復唱確認・
        barge-in インジケータ・タッチ縮退案内を担う。未指定なら一切マウントされない（無変更動作）。
        `receptionState={data.state}` は第9wave のゼロタッチ自動化配線: voiceSession は reception
        状態機械を直接観測できないため、この prop 経由で現在局面（少なくとも selectingTarget か）を
        通知する。demo-studio の synthetic driver はこれを合図に発話シーケンスを (再)開始できる
        （実 orchestrator 経路は同 hook を実装しないため無影響 = 中立な通知口）。
      */}
      {effectiveVoiceSession ? (
        <VoiceSessionLayer
          factory={effectiveVoiceSession}
          locale={locale}
          receptionState={data.state}
          onResolved={handleVoiceResolved}
        />
      ) : null}
      {inactivitySeconds !== null ? (
        <InactivityWarning
          seconds={inactivitySeconds}
          locale={locale}
          onContinue={() => extendInactivityRef.current()}
        />
      ) : null}
      {!online ? (
        // 受付のどの局面でも出る来訪者向けのお知らせ。しかも通信断は失敗時フォールバックの
        // 入口そのものなので、選んだ言語で出さないと最も助けが要る場面で読めなくなる (#327)。
        <div
          className="notice notice--warning"
          data-testid="kiosk-offline"
          lang={htmlLangFor(locale)}
          style={{ marginBottom: 'var(--space-md)' }}
        >
          {makeT(locale)('reception.offlineNotice')}
        </div>
      ) : null}
      {view === 'revoked' ? (
        <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <div className="notice notice--danger" data-testid="kiosk-revoked" lang={htmlLangFor(locale)}>
            {makeT(locale)('kiosk.deviceUnavailable')}
          </div>
        </div>
      ) : view === 'authorize' ? (
        <KioskAuthorizeView onAuthorized={markAuthorized} />
      ) : view === 'unenrolled' ? (
        <KioskUnenrolledView />
      ) : view === 'checking' ? (
        <KioskCheckingView />
      ) : mode === 'checkin' ? (
        // QR 受付モード (issue #98)。通常受付選択 / 終了で normal へ戻す（個人情報は破棄される）。
        // #361: 通常受付と同じアバター継続レール・字幕シェルで提示するため、アバター資産と
        // locale/layout を渡す（別アプリに見せない）。表示契約は checkinConversationTurnFor。
        <CheckinFlow
          // QR ペイロード注入 (#363)。注入 prop / `?debugScanPayload=` があればカメラ無しで
          // 読み取りを再現、無ければ実カメラ（CameraQrScanner）のまま（非破壊）。
          scanner={effectiveQrScanner}
          onUseManual={() => setMode('normal')}
          onExit={() => setMode('normal')}
          locale={locale}
          layout={layout}
          vrmUrl={vrmUrl}
          avatarFallbackUrl={avatarFallbackUrl}
          motionUrls={motions.motions}
          defaultMotionUrl={motions.defaultUrl}
        />
      ) : kioskMode === 'out_of_hours' ? (
        // 営業時間外の待機画面 (#367)。resolveKioskMode が closed かつ idle のときだけ到達する。
        // 受付進行中は out_of_hours にならないため、進行中の来訪者を中断しない。
        <OutOfHoursView
          status={operatingStatus ?? { state: 'closed' }}
          locale={locale}
          onLocaleChange={setLocale}
        />
      ) : showSignage ? (
        // 待機サイネージ (issue #101) + 来訪検知 (issue #79) + ATTRACT (issue #362)。
        // タップ/ATTRACT CTA/QR/退館で受付へ。来訪検知の自動検知は ATTRACT オーバーレイの
        // 表示だけを行い、受付開始は常に明示 CTA タップから startReception/checkin を呼ぶ。
        <SignageWaitingView
          onStart={startReception}
          onStartCheckin={() => setMode('checkin')}
          presenceEnabled={presenceEnabled}
          onTogglePresence={() => setPresenceEnabled((v) => !v)}
          presenceStatus={presence.status}
          attractVisible={attractVisible}
          onAttractStart={startReceptionFromAttract}
          onAttractStartCheckin={startCheckinFromAttract}
          locale={locale}
        />
      ) : useCustomFlow && data.state === 'selectingPurpose' ? (
        // カスタム目的選択 (issue #100)。選択でフローを保持し、入力ステップ有無で次へ分岐。
        <CustomPurposeView
          locale={locale}
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
          {/* 画面遷移ごとに key を変え、上品な入場アニメを再生する（#119 UX 仕上げ）。 */}
          <div className="screen-anim" key={data.state}>
            {renderScreen({
              data,
              dispatch,
              complete,
              onFallback: handleFallback,
              directory,
              guidanceIdle,
              vrmUrl,
              avatarFallbackUrl,
              sttEnabled,
              motionUrl,
              vonageCallId,
              staffResponse,
              onStaffResponseFallback: handleStaffResponseFallback,
              onEntry: startWithEntry,
              onHandoff: handoffToShell,
              locale,
              onLocaleChange: setLocale,
              branding,
              // 音声候補クリック時のみ実行される安定コールバック（レンダー中に ref を触らない, #319）。
              onVoiceUse: markVoiceInput,
              // 受付完了画面に提示する退館クレデンシャル (#342)。connected 完了時のみ非 null。
              checkoutCredential,
              privacyNoticeOverride,
              presenceCameraEnabled: presenceEnabled,
              // 同様に、デバウンス後の検索実行時のみ ref を更新する安定コールバック (#322)。
              onSearchQuery: markSearchQuery,
              onRequestChat: requestChatOpen,
              // 呼び出し中の段階的ケア (#323)。UI 層のタイマー派生（state.ts/ui-contract.ts は不変）。
              callingStageState,
              callingStageTextOverride,
              // ワンタップ満足度フィードバック (#320)。完了/未応答/失敗画面のみが使う。
              feedback: { enabled: feedbackEnabled, onSubmit: submitFeedback },
              // STT アダプタ注入 (#370)。未指定は既定 MockSttAdapter（無変更動作）。
              sttAdapterFactory,
              // 取次段階 (#363)。Vonage 非同期通話ビュー（KioskCallView）が段階表示する。
              callStages,
            })}
          </div>
          {/*
            #123 アバター常設コンパニオン。screenState（=data.state）から表情/モーション/字幕を
            導出し受付に「付き添う」。pointer-events:none で操作は妨げない。
            選択/入力画面はカードや入力欄でコンテンツが密集し重なるため出さず、中央寄せで余白のある
            ステータス画面（呼び出し中/結果/お詫び/完了）に限定する。ここはアバターの感情表現
            （呼び出し中=気遣い・完了=お見送り・失敗=お詫び）が最も活きる場面でもある。
            待機画面は IdleView 側がヒーローとして大きく表示する。
          */}
          {showAvatarCompanion(data.state, layout) ? (
            <div
              className="kiosk-avatar-companion"
              aria-hidden="true"
              {...persistentRegionProps('kiosk-avatar-companion')}
            >
              <AvatarGuide
                screenState={data.state}
                locale={locale}
                vrmUrl={vrmUrl}
                fallbackImageUrl={avatarFallbackUrl}
                defaultMotionUrl={motionUrl}
                guidanceOverride={callingAvatarGuidanceOverride}
                layout={layout}
              />
            </div>
          ) : null}
          {/* 退館チェックアウト導線 (issue #102)。待機中のみ小さく常設する（非破壊）。 */}
          {isElementVisible('kiosk-checkout-link', data.state) ? (
            <CheckoutLink locale={locale} />
          ) : null}
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
              locale={locale}
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
                if (next) leaveWithServer(next);
              }}
            />
          </div>
        </>
      )}
      {/*
        常時見える「逃げ道」バー (issue #121 / #325)。後退系コントロールはここに一本化し、
        戻る（1 ステップ）/ 最初に戻る（リセット）の 2 語だけを出す。出すアクションは #120 契約の
        availableActions に従う（許可外は出さない）。各画面のコンテンツ側は前進系（主 CTA）と
        文脈固有（修正する）に限定し、後退ボタンは置かない（同一機能ボタンの二重表示を解消）。

        **画面分岐の外に置く**（#455 レビュー指摘）。以前は既定受付の枝の中に在ったため、
        カスタム受付フロー (#100) の 2 画面では逃げ道が 1 つも描画されず、来訪者は 60 秒の
        無操作リセットを待つしかない**行き止まり**になっていた。分岐が増えるたびに
        「バーを入れ忘れる」余地を残さないよう、構造として全画面の外側へ出す。
        逃げ道を出さない局面（idle・端末ゲート系・QR 受付モード）は `escapeHatchesFor` が
        空を返して null になるので、ここに置いても余計なものは出ない。
      */}
      <EscapeBar
        barRef={escapeBarRef}
        regionTestId="kiosk-escape-bar"
        locale={locale}
        // 出す項目は契約（`escapeHatchActionsFor`）由来。バーは描画だけを持つ。
        items={escapeHatchesFor(data.state).map((hatch) => ({ id: hatch.action, ...hatch }))}
        onSelect={(id) => {
          // escapeHatchesFor が返すのは back/reset のみ（#325）。状態機械イベントへ写す。
          const eventByAction: Partial<Record<ReceptionAction, Action>> = {
            back: { type: 'BACK' },
            reset: { type: 'RESET' },
          };
          const next = eventByAction[id as ReceptionAction];
          if (next) leaveWithServer(next);
        }}
      />
    </main>
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
        // 端末 ID は送らない (#419)。PIN 自己許可は端末 ID を持たない初回経路で、
        // サーバが dev 既定へ倒す。以後の端末 ID はセッションが権威になる。
        body: JSON.stringify({ pin }),
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
 * 待機サイネージ + 来訪検知の待機画面 (issue #101 / #79 / #362 統合)。
 *
 * 埋め込み版 SignageDisplay（onStart で受付状態機械の START を呼ぶ）に、来訪検知トグルと
 * 受付/QR/退館の明示導線を重ねる。受付開始導線は常に大きく表示する（issue #101 UX 方針）。
 * カメラはトグル ON のときだけ起動し、未対応/拒否（unavailable）でもタップ起動で完走する
 * （カメラ権限拒否時もタップで受付開始できる, issue #362 AC）。
 *
 * ATTRACT (issue #362): 来訪検知が「端末前に人がいそう」と判定すると `attractVisible` が
 * true になり、`AttractOverlay` を最前面に重ねる。オーバーレイ表示中は SignageDisplay を
 * `paused` にして項目巡回とタップ/キー操作での復帰を止め（＝下の待機画面が同時に反応しない）、
 * 受付開始/QR受付開始はオーバーレイの明示 CTA タップからのみ行う。マイク・QR カメラ・
 * 受付セッション・発信はこの段階では一切開始しない。
 */
function SignageWaitingView({
  onStart,
  onStartCheckin,
  presenceEnabled,
  onTogglePresence,
  presenceStatus,
  attractVisible,
  onAttractStart,
  onAttractStartCheckin,
  locale,
}: {
  onStart: () => void;
  onStartCheckin: () => void;
  presenceEnabled: boolean;
  onTogglePresence: () => void;
  presenceStatus: PresenceCameraStatus;
  /** ATTRACT オーバーレイを表示するか (issue #362)。 */
  attractVisible: boolean;
  /** ATTRACT オーバーレイの受付 CTA タップ。 */
  onAttractStart: () => void;
  /** ATTRACT オーバーレイの QR 受付 CTA タップ。 */
  onAttractStartCheckin: () => void;
  /**
   * 表示言語 (#327)。埋め込み SignageDisplay・退館チェックアウト導線 (CheckoutLink)・
   * QR 受付/来訪検知トグルの各文言に共通で使う（以前は SignageDisplay と QR/来訪検知の
   * 2 箇所が locale に連動しない翻訳漏れだった）。
   */
  locale: Locale;
}) {
  const tr = makeT(locale);
  // フッター（QR受付/退館/来訪検知）は絶対配置でサイネージへ重ねるため、実高さを計測して
  // SignageDisplay 側に paddingBottom として渡す。iPad 縦などでフッターが折り返して 2 段に
  // なると「画面をタップして受付を開始」CTA と重なる（実ブラウザ検証で発見）。
  // escape バーと同じ ResizeObserver 計測パターン（本ファイル上部参照）。
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  useEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    const measure = () => setFooterHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div data-testid="kiosk-signage-waiting" style={{ position: 'relative', minHeight: '100%' }}>
      <SignageDisplay
        onStart={onStart}
        locale={locale}
        paused={attractVisible}
        bottomInsetPx={footerHeight}
      />
      <div
        ref={footerRef}
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
      {attractVisible ? (
        <AttractOverlay onStart={onAttractStart} onStartCheckin={onAttractStartCheckin} locale={locale} />
      ) : null}
    </div>
  );
}

/**
 * ATTRACT オーバーレイ (issue #362)。来訪検知が「端末前に人がいそう」と判定したときだけ
 * 画面が反応する段階。キャラクター＋CTA のみに反応し、サイネージ本体は呼び出し側で
 * `SignageDisplay` を `paused` にして止めている（本コンポーネントは画面全体を覆う軽い暗転と
 * 挨拶・CTA の表示だけを担当する）。
 *
 * ここからは明示 CTA タップでのみ受付/QR受付へ進む。マイク・QR カメラ・受付セッション・
 * 発信はまだ一切開始しない。オーバーレイ自体は画面全体を覆って下の SignageDisplay への
 * タップ漏れを防ぐが、CTA 以外の領域タップは無視する（何も起きない＝通行人の接触では
 * 受付は始まらない）。無操作タイムアウトでの待機復帰は呼び出し側（KioskFlow の
 * `usePresenceCamera` `onAttractTimeout`）が担う。
 */
function AttractOverlay({
  onStart,
  onStartCheckin,
  locale,
}: {
  onStart: () => void;
  onStartCheckin: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  return (
    <div
      data-testid="kiosk-attract-overlay"
      role="dialog"
      aria-label={tr('kiosk.attract.greeting')}
      // CTA 以外へのタップ/クリックは意図的に何もしない（下のサイネージへ伝播もさせない）。
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-xl)',
        textAlign: 'center',
        background: 'var(--color-scrim)',
        color: 'var(--color-on-scrim)',
      }}
    >
      {/* 挨拶と CTA は不透明パネルに載せる。scrim 越しに背後のサイネージ文言が透けて
          挨拶文と重なり読めなくなるため（実ブラウザ検証で発見）。 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-lg)',
          padding: 'var(--space-xl)',
          borderRadius: 24,
          background: 'var(--color-surface)',
          boxShadow: 'var(--shadow-lg)',
          maxWidth: '90%',
        }}
      >
        <p
          lang={htmlLangFor(locale)}
          style={{ fontSize: 'clamp(24px, 4vw, 56px)', fontWeight: 700, margin: 0 }}
        >
          {tr('kiosk.attract.greeting')}
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="attract-start"
            lang={htmlLangFor(locale)}
            onClick={onStart}
            style={{ fontSize: 'clamp(18px, 2.5vw, 32px)', padding: '16px 40px' }}
          >
            {tr('kiosk.attract.startCta')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="attract-start-checkin"
            lang={htmlLangFor(locale)}
            onClick={onStartCheckin}
          >
            {tr('kiosk.action.checkin.label')}
          </button>
        </div>
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
      {...persistentRegionProps('kiosk-checkout-link')}
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
  locale,
}: {
  flows: readonly KioskCustomFlow[];
  onSelect: (flow: KioskCustomFlow) => void;
  locale: Locale;
}) {
  // 「最初に戻る」は常設の逃げ道バーに一本化（画面内フッターとの二重表示を解消, #121）。
  return (
    <>
      <div className="screen__body" data-testid="custom-purpose-view">
        <PurposeSelector flows={flows} onSelect={onSelect} locale={locale} />
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
            {makeT(locale)('reception.proceedConfirm')}
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
      <VisitorInfoForm fields={flow.fields} onSubmit={onSubmit} locale={locale} />
    </div>
  );
}
