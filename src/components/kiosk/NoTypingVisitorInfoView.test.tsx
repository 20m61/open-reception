import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoTypingVisitorInfoView, type NoTypingVisitorInfoCopy } from './NoTypingVisitorInfoView';
import type { VisitorNameRecognizerFactory } from './visitor-name-recognizer';

const copy: NoTypingVisitorInfoCopy = {
  title: 'お名前を教えてください',
  prompt: 'マイクを押して、お名前を話してください',
  listen: 'お名前を話す',
  listening: '聞き取り中…',
  candidatesPrompt: 'お名前を選んでください',
  confirmPrompt: 'このお名前でよろしいですか？',
  confirmYes: 'はい',
  retry: 'ちがう・もう一度話す',
  recognitionFailed: 'うまく聞き取れませんでした',
  voiceUnavailable: '音声入力を利用できません',
  assistance: '受付担当に相談する',
};

const recognizerFactory: VisitorNameRecognizerFactory = () => ({
  recognize: async () => ['来客 太郎'],
});

function render(over: Partial<Parameters<typeof NoTypingVisitorInfoView>[0]> = {}): string {
  return renderToStaticMarkup(
    <NoTypingVisitorInfoView
      recognizerFactory={recognizerFactory}
      onSubmit={vi.fn()}
      copy={copy}
      locale="ja"
      {...over}
    />,
  );
}

describe('NoTypingVisitorInfoView (#1057)', () => {
  it('visitor-facing typing control を一切描画しない', () => {
    const html = render();
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('contentEditable');
    expect(html).not.toContain('data-testid="visitor-company"');
    expect(html).not.toContain('data-testid="visitor-note"');
  });

  it('新規来訪者は音声開始ボタンだけを主入力として提示する', () => {
    const html = render();
    expect(html).toContain('data-testid="no-typing-visitor-info"');
    expect(html).toContain('data-testid="visitor-name-listen"');
    expect(html).not.toContain('data-testid="visitor-name-confirm"');
  });

  it('recognizer が無い場合も keyboard を出さず、有人支援があればその導線を出す', () => {
    const html = render({ recognizerFactory: undefined, onRequestAssistance: vi.fn() });
    expect(html).not.toContain('data-testid="visitor-name-listen"');
    expect(html).toContain('data-testid="visitor-info-assistance"');
    expect(html).not.toContain('<input');
  });

  it('確認画面から BACK した既存氏名は消さず、明示確認から再開する', () => {
    const html = render({
      initial: { name: '既存 来訪者', company: '既存会社', note: '既存補足' },
    });
    expect(html).toContain('data-testid="visitor-name-review"');
    expect(html).toContain('data-testid="visitor-name-recognized"');
    expect(html).toContain('既存 来訪者');
    expect(html).toContain('data-testid="visitor-name-confirm"');
    // company/note は保持対象だが、このターンでフォームとして再表示・再収集しない。
    expect(html).not.toContain('data-testid="visitor-company"');
    expect(html).not.toContain('data-testid="visitor-note"');
  });

  it('privacy notice を同じ Reception Stage 内に差し込める', () => {
    const html = render({ privacyNotice: <div data-testid="privacy-probe">privacy</div> });
    expect(html).toContain('data-testid="privacy-probe"');
  });

  it('live region は状態変化前から常設する', () => {
    const html = render();
    const at = html.indexOf('data-testid="visitor-name-status"');
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
    expect(tag).toContain('role="status"');
  });
});
