/**
 * 受付フローの状態と遷移 (issue #422 increment 4)。
 *
 * `KioskFlow` から切り出した**純ロジック**。画面・副作用を持たないので単体テストで直接
 * 突ける（`flow-state.test.ts`）。遷移表そのものは `src/domain/reception/state.ts` が正で、
 * ここはそれに「受付中に持ち回るデータ（目的・相手・来訪者情報・結果）」を重ねる層。
 *
 * **不正遷移は現状維持**（`transition` が null を返したら data をそのまま返す）。受付端末は
 * 公共の場に置かれ、連打・戻る・タイムアウトが重なるため、想定外のイベントで画面を壊さない
 * ことを状態機械の側で保証する。
 */
import type { ReceptionPurposeId, VisitorInfo } from '@/domain/reception/session';
import {
  transition,
  type ReceptionEvent,
  type ReceptionState,
} from '@/domain/reception/state';
import type { CallFailureReason } from '@/domain/reception/call-failure';
import type { ReceptionTarget } from './voice-target-binding';

export type Target = ReceptionTarget;
export type CallOutcome = 'connected' | 'timeout' | 'failed';

/**
 * 受付完了画面へ提示する退館クレデンシャル (issue #342)。/api/kiosk/checkout/issue の戻り値。
 * token/code は秘密（PII ではない）。ログには出さず表示のためだけに保持する。
 */
export type CheckoutCredential = { token: string; code: string; expiresAt: string };

export type FlowData = {
  state: ReceptionState;
  purpose?: ReceptionPurposeId;
  target?: Target;
  visitor?: VisitorInfo;
  sessionId?: string;
  outcome?: CallOutcome;
  /**
   * 呼び出しが失敗した理由 (#422)。**状態は増やさず**、`failed` の中の説明にだけ使う。
   * 通信断とサーバ側の失敗を同じ文言で伝えないため（`domain/reception/call-failure.ts`）。
   */
  failureReason?: CallFailureReason;
  /**
   * クイックアクションで用件を先取りした場合の目的 (issue #121)。
   * START 直後に selectingPurpose で自動選択し、目的選択画面をスキップして担当/部署選択へ
   * 進めるためのヒント。担当者を呼ぶ（用件未確定）では undefined のまま通常の目的選択を出す。
   */
  pendingPurpose?: ReceptionPurposeId;
};

export type Action =
  | { type: 'START'; pendingPurpose?: ReceptionPurposeId }
  | { type: 'SELECT_PURPOSE'; purpose: ReceptionPurposeId }
  | { type: 'SELECT_TARGET'; target: Target }
  | { type: 'SUBMIT_VISITOR_INFO'; visitor: VisitorInfo }
  | { type: 'CONFIRM' }
  /**
   * 受付が作られ、受付 ID が確定した (#649)。**状態は動かさない**（`calling` のまま）。
   * 呼び出し中から担当者応答（`useStaffResponse`）や結果ポーリングが受付 ID を必要とするため、
   * 「ID は結果と一緒に来る」旧設計を、ID だけ先に立てる形へ改める。
   * `ReceptionEvent` ではないので遷移表（`domain/reception/state.ts`）は不変。
   */
  | { type: 'SESSION_CREATED'; sessionId: string }
  | { type: 'CALL_CONNECTED'; sessionId: string }
  | { type: 'CALL_TIMEOUT'; sessionId: string }
  | { type: 'CALL_FAILED'; sessionId?: string; reason?: CallFailureReason }
  | { type: 'USE_FALLBACK' }
  | { type: 'COMPLETE' }
  | { type: 'BACK' }
  | { type: 'CANCEL' }
  | { type: 'RESET' };

export const INITIAL: FlowData = { state: 'idle' };

export function reducer(data: FlowData, action: Action): FlowData {
  // 状態を動かさない action は遷移表を引く前に処理する (#649)。呼び出し中に限るのは、
  // 来訪者がキャンセルした後に届いた受付作成の応答で ID を立て直さないため
  // （「不正遷移は現状維持」と同じ考え方）。
  if (action.type === 'SESSION_CREATED') {
    if (data.state !== 'calling') return data;
    return { ...data, sessionId: action.sessionId };
  }

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
      return {
        ...data,
        state: next,
        // ID を伴わない失敗（`/call` が例外で落ちた等）で、確定済みの受付 ID を消さない (#649)。
        // 「action が ID を持たない」と「受付が存在しない」は別物。消すと終端画面からの
        // /fallback・/feedback の送信先が失われる。
        sessionId: action.sessionId ?? data.sessionId,
        outcome: 'failed',
        failureReason: action.reason,
      };
    case 'RESET':
      return INITIAL;
    default:
      return { ...data, state: next };
  }
}
