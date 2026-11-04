import {
  isConversationSlotOpen,
  mergeConversationDraft,
  nextConversationFocus,
  replaceConversationSlot,
  type ConversationDraft,
} from '@/domain/reception/conversation-draft';
import { normalizeVisitorNameInput } from '@/domain/reception/session';
import { resolveReceptionSlotProposal } from '@/domain/reception/slot-proposal';
import { classifyReadbackAnswer, extractVisitorName } from '@/domain/reception/visitor-name-extractor';
import { DEFAULT_ENTITY_RESOLUTION_THRESHOLDS } from '@/domain/voice-stt/entity-resolver';

/**
 * 音声で来訪者の氏名を聞き取る段の状態機械（ADR 0011 §2・§3・§6、#1290）。純関数。
 *
 * `inputVisitorInfo` の画面に居るあいだだけ動く。画面の出入り・通知の読み上げの結果・
 * キーボードでの入力は、呼び出し側（音声セッションの結線と `KioskFlow`）がイベントで知らせる。
 *
 * - 氏名を聞くのは、通知を**正常に**読み終えた後だけ（§2）。
 * - 候補は必ず復唱し、復唱への「はい」（声・ボタン）の直後だけ `confirmed` の効果を出す（§3-b）。
 * - 声の名乗りと答えには STT の下限、名乗りには抽出器の下限と長さの上限を課す（§3-a・§3-e）。
 *   判定は `resolveReceptionSlotProposal`（#1090）と ConversationDraft（#1088）に任せる。
 * - 失敗は累計 `VISITOR_NAME_MAX_ATTEMPTS` 回まで。尽きたらキーボードへ移る（§3-c）。
 * - 打ち始めたら止め、この画面では戻らない（§3-c）。画面を出たら候補も回数も捨てる（§6）。
 *
 * PII: 候補の氏名は `readback` の局面の draft にしか残さない。退けた・使えなかった言い直しは
 * `replaceConversationSlot` で draft から消し（`asking` の draft に氏名は無い）、確定・退出で draft ごと捨てる。
 * 効果（`readback` / `confirmed`）で外へ渡す氏名は、画面の表示・読み上げ・入力欄にだけ使い、
 * ログ・計測へ渡さない。
 */

/** 最初の質問 + 言い直し 2 回（owner の決定、2026-10-28）。 */
export const VISITOR_NAME_MAX_ATTEMPTS = 3;

/** 名乗り・復唱への答えを待つ時間。過ぎたら 1 回の失敗と数える（§3-c）。 */
export const VISITOR_NAME_ANSWER_TIMEOUT_MS = 12_000;

export type VisitorNameKeyboardReason = 'ineligible' | 'noticeFailed' | 'typing' | 'exhausted';

export type VisitorNameCapture =
  | { phase: 'off' }
  | { phase: 'notice' }
  | { phase: 'asking'; failures: number; draft: ConversationDraft }
  | { phase: 'readback'; failures: number; draft: ConversationDraft }
  | { phase: 'keyboard'; reason: VisitorNameKeyboardReason }
  | { phase: 'confirmed' };

export type VisitorNameCaptureEvent =
  /** `inputVisitorInfo` に入った。`eligible` は音声で聞いてよいか（TTS・言語・欄・確認から戻ったか）。 */
  | { type: 'enter'; eligible: boolean }
  /** 通知の読み上げが終わった。失敗・中断・時間切れは `ok: false`。 */
  | { type: 'noticeFinished'; ok: boolean }
  /** 確定した発話。interim は渡さない。 */
  | { type: 'heard'; text: string; sttConfidence: number }
  /** 復唱へのボタンの答え。 */
  | { type: 'answer'; yes: boolean }
  /** 名乗り・答えを待つ時間が過ぎた。 */
  | { type: 'noAnswer' }
  /** いずれかの欄へキーボードで入力した。 */
  | { type: 'typing' }
  /** `inputVisitorInfo` を出た（戻る・確認へ進む・リセット）。 */
  | { type: 'leave' };

export type VisitorNameCaptureEffect =
  /** 聞き取りを始める（「お話しください」）。 */
  | { kind: 'listen' }
  /** もう一度、氏名を尋ねる。 */
  | { kind: 'askAgain' }
  /** 候補を画面と読み上げで復唱する。 */
  | { kind: 'readback'; name: string }
  /** 確定した（`onVisitorNameConfirmed` へ渡す）。 */
  | { kind: 'confirmed'; name: string }
  /** 言い直しが尽きた。キーボードへフォーカスを移して案内する。 */
  | { kind: 'keyboard' }
  /** 打ち始めたので、聞き取り・復唱の表示を畳む。 */
  | { kind: 'stopped' };

export type VisitorNameCaptureStep = {
  state: VisitorNameCapture;
  effect?: VisitorNameCaptureEffect;
};

export function initialVisitorNameCapture(): VisitorNameCapture {
  return { phase: 'off' };
}

/** 氏名の候補だけを解決するので、相手の辞書は空でよい（相手は前の画面で確定済み）。 */
const NO_DIRECTORY = { staff: [], departments: [] } as const;

function candidateName(text: string, sttConfidence: number): ConversationDraft['visitorName'] {
  const proposal = extractVisitorName(text);
  if (proposal === undefined) return undefined;
  return resolveReceptionSlotProposal(
    { visitorName: { ...proposal, value: normalizeVisitorNameInput(proposal.value) } },
    { directory: NO_DIRECTORY, sttConfidence },
  ).visitorName;
}

const SCREEN = 'inputVisitorInfo' as const;

/**
 * 言い直しが使える値にならなかった（「いいえ」・下限未満・抽出できない・上限超え・無応答）。
 * 氏名の slot がまだ開いているので、`replaceConversationSlot` で消してから聞き直す
 * （merge は「言及なし」を前の値の維持と読むので、消さないと前の候補が draft に残る。#1088）。
 */
function failed(failures: number, draft: ConversationDraft): VisitorNameCaptureStep {
  const next = failures + 1;
  if (next >= VISITOR_NAME_MAX_ATTEMPTS) {
    return { state: { phase: 'keyboard', reason: 'exhausted' }, effect: { kind: 'keyboard' } };
  }
  const cleared = isConversationSlotOpen('visitorName', SCREEN)
    ? replaceConversationSlot(draft, 'visitorName', undefined)
    : draft;
  return { state: { phase: 'asking', failures: next, draft: cleared }, effect: { kind: 'askAgain' } };
}

function readbackName(draft: ConversationDraft): string | undefined {
  const slot = draft.visitorName;
  return slot?.kind === 'resolved' ? slot.value : undefined;
}

function heardInAsking(
  state: Extract<VisitorNameCapture, { phase: 'asking' }>,
  text: string,
  sttConfidence: number,
): VisitorNameCaptureStep {
  const slot = candidateName(text, sttConfidence);
  if (slot === undefined) return failed(state.failures, state.draft);
  const draft = mergeConversationDraft(state.draft, { visitorName: slot }, SCREEN);
  const name = readbackName(draft);
  if (name === undefined || nextConversationFocus(draft, SCREEN).kind !== 'readback') {
    return failed(state.failures, draft);
  }
  const failures = state.failures;
  return { state: { phase: 'readback', failures, draft }, effect: { kind: 'readback', name } };
}

function confirm(state: Extract<VisitorNameCapture, { phase: 'readback' }>): VisitorNameCaptureStep {
  const name = readbackName(state.draft);
  if (name === undefined) return failed(state.failures, state.draft);
  const draft = replaceConversationSlot(state.draft, 'visitorName', {
    kind: 'resolved',
    value: name,
    evidence: { source: 'voice', certainty: 'confirmed' },
  });
  // 復唱への肯定で、planner から見ても氏名が取得済みになっていること（#1088 と同じ判定）。
  if (nextConversationFocus(draft, SCREEN).kind !== 'finalConfirmation') return failed(state.failures, state.draft);
  return { state: { phase: 'confirmed' }, effect: { kind: 'confirmed', name } };
}

/** 復唱を退けたら（「いいえ」・下限未満・どちらでもない・無応答）、候補を消して氏名から聞き直す（§3-c）。 */
function rejected(state: Extract<VisitorNameCapture, { phase: 'readback' }>): VisitorNameCaptureStep {
  return failed(state.failures, state.draft);
}

export function stepVisitorNameCapture(
  state: VisitorNameCapture,
  event: VisitorNameCaptureEvent,
): VisitorNameCaptureStep {
  if (event.type === 'leave') return { state: { phase: 'off' } };
  if (event.type === 'enter') {
    return {
      state: event.eligible ? { phase: 'notice' } : { phase: 'keyboard', reason: 'ineligible' },
    };
  }

  switch (state.phase) {
    case 'off':
    case 'keyboard':
    case 'confirmed':
      return { state };

    case 'notice':
      if (event.type === 'typing') return { state: { phase: 'keyboard', reason: 'typing' } };
      if (event.type !== 'noticeFinished') return { state };
      return event.ok
        ? { state: { phase: 'asking', failures: 0, draft: {} }, effect: { kind: 'listen' } }
        : { state: { phase: 'keyboard', reason: 'noticeFailed' } };

    case 'asking':
      switch (event.type) {
        case 'typing':
          return { state: { phase: 'keyboard', reason: 'typing' }, effect: { kind: 'stopped' } };
        case 'heard':
          return heardInAsking(state, event.text, event.sttConfidence);
        case 'noAnswer':
          return failed(state.failures, state.draft);
        default:
          return { state };
      }

    case 'readback':
      switch (event.type) {
        case 'typing':
          return { state: { phase: 'keyboard', reason: 'typing' }, effect: { kind: 'stopped' } };
        case 'answer':
          return event.yes ? confirm(state) : rejected(state);
        case 'heard': {
          // 声の答えにも STT の下限を課す。下限未満は「はい」とみなさない（§3-b）。
          if (event.sttConfidence < DEFAULT_ENTITY_RESOLUTION_THRESHOLDS.minSttConfidence) return rejected(state);
          return classifyReadbackAnswer(event.text) === 'yes' ? confirm(state) : rejected(state);
        }
        case 'noAnswer':
          return rejected(state);
        default:
          return { state };
      }
  }
}
