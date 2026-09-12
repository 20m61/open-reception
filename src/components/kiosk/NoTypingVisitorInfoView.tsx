'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { VisitorInfo } from '@/domain/reception/session';
import { htmlLangFor, type Locale } from '@/lib/i18n';
import {
  visitorNameRecognitionDisposition,
  type VisitorNameCandidate,
  type VisitorNameRecognizerFactory,
} from './visitor-name-recognizer';

export type NoTypingVisitorInfoCopy = {
  title: string;
  prompt: string;
  listen: string;
  listening: string;
  candidatesPrompt: string;
  confirmPrompt: string;
  confirmYes: string;
  retry: string;
  recognitionFailed: string;
  voiceUnavailable: string;
  assistance: string;
};

type Phase = 'idle' | 'listening' | 'choose' | 'confirm' | 'error';

/**
 * #1057 / #1077: 来訪者氏名を software keyboard なしで受け取る会話ターン。
 *
 * Minimum-Turn policy:
 * - high-confidence の単一候補は氏名だけの yes/no を挟まず、provisional VisitorInfo として
 *   `onSubmit` へ渡す。呼び出し確定は次の `confirming` で必ず明示タッチする。
 * - 複数候補は候補ボタンを押すこと自体が氏名の明示選択。選択後に同じ氏名をもう一度
 *   yes/no させない。
 * - low-confidence の単一候補だけ short readback + yes/no を挟む。
 * - 失敗時は再発話。有人支援は #1074 の状態契約が接続された時だけ CTA を有効化する。
 * - company / note をこのターンでは新規収集しない。戻り編集時に既存値があれば保持する。
 *
 * 自由発話 recognizer は外から注入し、担当者検索用 phrase-list STT を流用しない。
 * copy は i18n 辞書から呼び出し側が渡す。ここに visitor-facing 生文言を置かない。
 */
export function NoTypingVisitorInfoView({
  initial,
  recognizerFactory,
  onSubmit,
  onVoiceUse,
  onRecognitionResult,
  onRequestAssistance,
  privacyNotice,
  copy,
  locale,
}: {
  initial?: VisitorInfo;
  recognizerFactory?: VisitorNameRecognizerFactory;
  onSubmit: (visitor: VisitorInfo) => void;
  onVoiceUse?: () => void;
  onRecognitionResult?: (hasCandidate: boolean) => void;
  onRequestAssistance?: () => void;
  privacyNotice?: ReactNode;
  copy: NoTypingVisitorInfoCopy;
  locale: Locale;
}) {
  const initialName = initial?.name.trim() ?? '';
  // confirming から「修正する」で戻った場合だけ、既存氏名を明示して修正可否を選べるようにする。
  // 通常の新規認識 high path ではこの phase を通らない。
  const [phase, setPhase] = useState<Phase>(initialName === '' ? 'idle' : 'confirm');
  const [candidates, setCandidates] = useState<VisitorNameCandidate[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(
    initialName === '' ? null : initialName,
  );

  const submitName = useCallback(
    (name: string) => {
      onVoiceUse?.();
      onSubmit({
        name,
        // No Typing 化の途中で既に取得済みの値を BACK 編集だけで消さない。
        company: initial?.company,
        note: initial?.note,
      });
    },
    [initial?.company, initial?.note, onSubmit, onVoiceUse],
  );

  const listen = useCallback(async () => {
    if (!recognizerFactory || phase === 'listening') return;
    setPhase('listening');
    setCandidates([]);
    setSelectedName(null);

    try {
      const disposition = visitorNameRecognitionDisposition(
        await recognizerFactory().recognize(),
      );
      onRecognitionResult?.(disposition.kind !== 'error');

      if (disposition.kind === 'error') {
        setPhase('error');
        return;
      }

      if (disposition.kind === 'accept') {
        // high-confidence single candidate: local yes/no を増やさず final confirmation へ。
        submitName(disposition.candidate.text);
        return;
      }

      if (disposition.kind === 'confirm') {
        // low-confidence single candidateだけ、そのslotをshort readbackで修復する。
        setSelectedName(disposition.candidate.text);
        setPhase('confirm');
        return;
      }

      setCandidates(disposition.candidates);
      setPhase('choose');
    } catch {
      onRecognitionResult?.(false);
      setPhase('error');
    }
  }, [onRecognitionResult, phase, recognizerFactory, submitName]);

  const retry = useCallback(() => {
    setCandidates([]);
    setSelectedName(null);
    setPhase('idle');
  }, []);

  const confirmLowConfidence = useCallback(() => {
    if (!selectedName) return;
    submitName(selectedName);
  }, [selectedName, submitName]);

  const statusText =
    phase === 'listening'
      ? copy.listening
      : phase === 'error'
        ? copy.recognitionFailed
        : !recognizerFactory
          ? copy.voiceUnavailable
          : '';

  return (
    <>
      <h1 className="screen__title" lang={htmlLangFor(locale)}>
        {copy.title}
      </h1>
      <div className="screen__body" data-testid="no-typing-visitor-info">
        {privacyNotice}

        {/* 変化前から live region を置き、listening/error を支援技術へ届ける。 */}
        <p
          className="a11y-live"
          role="status"
          data-testid="visitor-name-status"
          lang={htmlLangFor(locale)}
        >
          {statusText}
        </p>

        {phase === 'idle' ? (
          <div className="field" data-testid="visitor-name-idle">
            <p className="screen__lead" lang={htmlLangFor(locale)}>
              {recognizerFactory ? copy.prompt : copy.voiceUnavailable}
            </p>
            {recognizerFactory ? (
              <button
                type="button"
                className="btn btn--primary"
                data-testid="visitor-name-listen"
                onClick={() => void listen()}
              >
                {copy.listen}
              </button>
            ) : null}
            {onRequestAssistance ? (
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="visitor-info-assistance"
                onClick={onRequestAssistance}
              >
                {copy.assistance}
              </button>
            ) : null}
          </div>
        ) : null}

        {phase === 'listening' ? (
          <div className="field" data-testid="visitor-name-listening" aria-busy="true">
            <p className="screen__lead" lang={htmlLangFor(locale)}>
              {copy.listening}
            </p>
          </div>
        ) : null}

        {phase === 'choose' ? (
          <div className="field" data-testid="visitor-name-candidates">
            <p className="screen__lead" lang={htmlLangFor(locale)}>
              {copy.candidatesPrompt}
            </p>
            <div className="card-grid">
              {candidates.map((candidate, index) => (
                <button
                  key={`${candidate.text}-${index}`}
                  type="button"
                  className="card"
                  data-testid={`visitor-name-candidate-${index}`}
                  data-certainty={candidate.certainty}
                  onClick={() => {
                    // 候補ボタン自体が明示選択。同じ氏名をさらに yes/no させない。
                    submitName(candidate.text);
                  }}
                >
                  {candidate.text}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="visitor-name-retry"
              onClick={retry}
            >
              {copy.retry}
            </button>
          </div>
        ) : null}

        {phase === 'confirm' && selectedName ? (
          <div className="field" data-testid="visitor-name-review">
            <p className="screen__lead" lang={htmlLangFor(locale)}>
              {copy.confirmPrompt}
            </p>
            <div className="notice" data-testid="visitor-name-recognized">
              <strong>{selectedName}</strong>
            </div>
            <div className="card-grid">
              <button
                type="button"
                className="btn btn--primary"
                data-testid="visitor-name-confirm"
                onClick={confirmLowConfidence}
              >
                {copy.confirmYes}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="visitor-name-retry"
                onClick={retry}
              >
                {copy.retry}
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="notice notice--warning" data-testid="visitor-name-error">
            <p lang={htmlLangFor(locale)}>{copy.recognitionFailed}</p>
            <div className="card-grid">
              {recognizerFactory ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  data-testid="visitor-name-retry"
                  onClick={retry}
                >
                  {copy.retry}
                </button>
              ) : null}
              {onRequestAssistance ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  data-testid="visitor-info-assistance"
                  onClick={onRequestAssistance}
                >
                  {copy.assistance}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
