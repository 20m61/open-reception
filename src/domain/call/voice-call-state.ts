/**
 * 担当者への外線通話の状態機械 (issue #4 MVP 1)。
 *
 * Provider webhook は **at-least-once かつ順不同**で届く。よってこの写像は
 * 「イベント列を順に畳み込んでも壊れない」ことを性質として持つ:
 *
 * 1. **terminal に達したら二度と動かない**（`completed` が遅れて届いても「向かう」を消さない）。
 * 2. **順不同でも巻き戻らない**（`completed` が `answered` より先に来ても進行中へ戻さない）。
 * 3. **同じイベントの重複は無害**（真の冪等＝二重処理の防止は `domain/routing/ledger.ts` の責務。
 *    ここは「万一 2 回通っても状態が壊れない」ことだけを担保する）。
 *
 * 純関数。HTTP・Vonage・永続化を知らない。MVP 2（ライブ音声ブリッジ）の `bridging` /
 * `connected` は**まだ足さない** — 消費者が居ない語彙は腐るため、#376 の方式確定後に足す。
 */
import type { RouteResult } from '@/domain/routing/policy';
import { staffChoiceToRouteResult, type StaffChoice } from './voice-announcement';

/** 通話の状態。MVP 1 の範囲（bridging / connected は MVP 2）。 */
export type VoiceCallState =
  | 'queued'
  | 'ringing'
  | 'awaiting_acceptance'
  | 'answered'
  | 'staff_coming'
  | 'declined'
  | 'no_answer'
  | 'busy'
  | 'failed';

/** これ以上動かない状態。ここへ来たら後続イベントは全て無視する。 */
export const TERMINAL_VOICE_STATES = [
  'answered',
  'staff_coming',
  'declined',
  'no_answer',
  'busy',
  'failed',
] as const satisfies readonly VoiceCallState[];

export type TerminalVoiceState = (typeof TERMINAL_VOICE_STATES)[number];

export function isTerminalVoiceState(state: VoiceCallState): state is TerminalVoiceState {
  return (TERMINAL_VOICE_STATES as readonly VoiceCallState[]).includes(state);
}

/** Vonage Voice の通話ステータス（受け取る側で正規化する語彙）。 */
export type VonageCallStatus =
  | 'ringing'
  | 'answered'
  | 'busy'
  | 'unanswered'
  | 'timeout'
  | 'rejected'
  | 'failed'
  | 'completed';

export type VoiceCallEvent =
  | { readonly kind: 'status'; readonly status: VonageCallStatus }
  | { readonly kind: 'dtmf'; readonly choice: StaffChoice };

export function initialVoiceCallState(): VoiceCallState {
  return 'queued';
}

export function applyVoiceEvent(state: VoiceCallState, event: VoiceCallEvent): VoiceCallState {
  // 性質 1・2: 一度確定したら動かさない。順不同・遅延配信はここで吸収される。
  if (isTerminalVoiceState(state)) return state;

  if (event.kind === 'dtmf') {
    const result = staffChoiceToRouteResult(event.choice);
    // 取次語彙 → 通話状態。accept は「来訪者と話す」意思表示（MVP 1 では通話成立＝ answered）。
    return result === 'answered' ? 'answered' : result === 'staff_coming' ? 'staff_coming' : 'declined';
  }

  switch (event.status) {
    case 'ringing':
      // 応答後に遅れて届いた ringing で巻き戻さない。
      return state === 'queued' ? 'ringing' : state;
    case 'answered':
      // 応答＝ここから意思表示待ち。まだ取次結果は確定していない。
      return 'awaiting_acceptance';
    case 'busy':
      return 'busy';
    case 'unanswered':
    case 'timeout':
      return 'no_answer';
    case 'rejected':
      return 'declined';
    case 'failed':
      return 'failed';
    case 'completed':
      // **通話が終わったこと自体は取次結果ではない。** ここへ来る時点で terminal は
      // short-circuit 済みなので、残るのは queued / ringing / awaiting_acceptance ──
      // いずれも「誰も向かうと言っていない」。よって一律 no_answer で次の手へ進める。
      // 終端成功にすると、誰も来ないまま取次が止まって来訪者が放置される。
      return 'no_answer';
  }
}

/**
 * 通話状態を取次語彙へ写す。**進行中は undefined** ── 未確定を確定として扱わせないため
 * （呼び出し側が「まだ結果が無い」を握り潰して次の手へ進めるのを型で防ぐ）。
 */
export function voiceStateToRouteResult(state: VoiceCallState): RouteResult | undefined {
  switch (state) {
    case 'answered':
      return 'answered';
    case 'staff_coming':
      return 'staff_coming';
    case 'declined':
      return 'declined';
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'ringing':
    case 'awaiting_acceptance':
      return undefined;
  }
}
