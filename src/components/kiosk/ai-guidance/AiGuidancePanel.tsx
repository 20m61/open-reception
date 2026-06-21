'use client';

/**
 * AI 案内のスタンドアロン UI (issue #104 increment 1)。
 *
 * 重要: KioskFlow へは組み込まない（独立コンポーネント）。本 increment では
 * プレゼンテーションのみで、実 LLM を呼ばない。状態機械（domain/ai-guidance）の
 * 状態に応じて、補助案内・引き継ぎ中・代替導線への切替表示を出し分ける。
 *
 * 安全方針の UI 表現:
 *  - AI は補助である旨を常に明示する。
 *  - エスカレーション時は AI 回答を見せず、担当者へつないでいる旨を表示する。
 *  - いつでも担当者を呼べるボタンを置き、AI に閉じ込めない。
 */
import type { AiGuidanceState } from '@/domain/ai-guidance';

export type AiGuidancePanelProps = {
  state: AiGuidanceState;
  /** guiding 中に表示する AI の補助案内文（エスカレーション時は無視される）。 */
  answer?: string;
  /** 来訪者が明示的に担当者を呼ぶハンドラ（常時押せる）。 */
  onRequestHuman: () => void;
};

const HEADLINE: Record<AiGuidanceState, string> = {
  guiding: 'AI がご案内します（補助）',
  handoff_requested: '担当者におつなぎしています',
  handed_off: '担当者が対応します',
  failed: '受付窓口へご案内します',
};

const BODY: Record<AiGuidanceState, string> = {
  guiding: 'お困りの場合はいつでも担当者を呼べます。',
  handoff_requested: '少々お待ちください。担当者へ取り次いでいます。',
  handed_off: 'このままお待ちください。',
  failed: 'お手数ですが受付窓口へお声がけください。',
};

export function AiGuidancePanel({ state, answer, onRequestHuman }: AiGuidancePanelProps) {
  const showAnswer = state === 'guiding' && answer && answer.length > 0;
  return (
    <section data-testid="ai-guidance-panel" data-state={state} aria-live="polite">
      <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>AI 案内は補助です。最終的なご案内は担当者が行います。</p>
      <h2 style={{ marginTop: '0.5rem' }}>{HEADLINE[state]}</h2>
      {showAnswer ? (
        <p data-testid="ai-guidance-answer">{answer}</p>
      ) : (
        <p data-testid="ai-guidance-body">{BODY[state]}</p>
      )}
      {state === 'guiding' ? (
        <button type="button" data-testid="ai-guidance-request-human" onClick={onRequestHuman}>
          担当者を呼ぶ
        </button>
      ) : null}
    </section>
  );
}
