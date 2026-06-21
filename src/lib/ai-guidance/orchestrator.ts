/**
 * AI 案内オーケストレーション (issue #104 increment 1)。
 *
 * 役割: provider（LLM, mock）の出力をエスカレーション判定へ橋渡しし、必要なら
 * 状態機械を通して引き継ぎ要求 → 引き継ぎ確定/失敗/フォールバックまで進める。
 *
 * 安全方針（不変条件）:
 *  1. AI は受付操作を即時実行しない。エスカレーションは必ず handoff_requested を経由する。
 *  2. 引き継ぎの成否は HandoffChannel（有人/担当者導線）が決める。AI は決めない。
 *  3. provider の回答テキストはエスカレーション判定に使わず、計量値のみ使う。
 *  4. PII・会話内容は session に保持しない。
 *
 * 本モジュールは副作用として provider/channel の async 呼び出しを行うが、ドメインの
 * 状態遷移自体は純関数（domain/ai-guidance）に委譲する。
 */
import {
  type AiGuidanceSession,
  type GuidanceTurnSignal,
  applyTurn,
  dispatch,
} from '@/domain/ai-guidance';
import type { GuidanceProvider, HandoffChannel } from './types';

export type GuidanceTurnInput = {
  locale: string;
  utterance: string;
  allowedTopics: ReadonlyArray<string>;
  now: string;
};

export type GuidanceTurnResult = {
  session: AiGuidanceSession;
  /** 来訪者へ提示してよい回答（エスカレーション時は空にしてフォールバック案内に切替）。 */
  answer: string;
  /** このターンでエスカレーション（引き継ぎ要求）したか。 */
  escalated: boolean;
};

/**
 * 1 ターンを処理する。provider を呼んでシグナルを得て、applyTurn でエスカレーション判定。
 * エスカレーション時は回答テキストを破棄し（誤案内をそのまま見せない）、引き継ぎ案内へ。
 */
export async function runGuidanceTurn(
  session: AiGuidanceSession,
  input: GuidanceTurnInput,
  provider: GuidanceProvider,
): Promise<GuidanceTurnResult> {
  const response = await provider.generate({
    sessionId: session.id,
    locale: input.locale,
    utterance: input.utterance,
    allowedTopics: input.allowedTopics,
  });

  const signal: GuidanceTurnSignal = {
    confidence: response.confidence,
    // スコープ外は「解決できなかった」扱いにする（誤案内防止）。
    resolved: !response.outOfScope,
    ngWordDetected: response.ngWordDetected,
    // mock/実 LLM とも明示要求の検知は provider 側責務だが、本 increment では
    // 上位 UI が userRequestedHuman を直接渡す経路も想定し、ここでは false 固定。
    userRequestedHuman: false,
  };

  const nextSession = applyTurn(session, signal, input.now);
  const escalated = nextSession.state === 'handoff_requested' && session.state === 'guiding';

  return {
    session: nextSession,
    // エスカレーション時は回答を見せず、引き継ぎ中である旨を上位が案内する。
    answer: escalated ? '' : response.answer,
    escalated,
  };
}

/**
 * 引き継ぎ要求を担当者/有人導線へ取り次ぐ。handoff_requested 状態でのみ呼ぶ。
 * 成立すれば handed_off、失敗すれば failed へ。失敗時は呼び出し側が finalizeFallback で
 * 既存受付フロー/代替導線へ戻す。
 */
export async function performHandoff(
  session: AiGuidanceSession,
  channel: HandoffChannel,
  now: string,
): Promise<AiGuidanceSession> {
  if (session.state !== 'handoff_requested') {
    return session;
  }
  const outcome = await channel.requestHandoff({
    sessionId: session.id,
    kioskId: session.kioskId,
    reason: session.escalationReason ?? 'user_request',
  });
  return dispatch(session, outcome.accepted ? 'HANDOFF_CONFIRMED' : 'HANDOFF_FAILED', now);
}

/**
 * 引き継ぎ失敗（failed）後のフォールバック確定。来訪者を既存受付フロー/代替導線へ戻し、
 * 終端（handed_off = 人間管轄に渡し切った）にする。
 */
export function finalizeFallback(session: AiGuidanceSession, now: string): AiGuidanceSession {
  if (session.state !== 'failed') {
    return session;
  }
  return dispatch(session, 'FALLBACK', now);
}
