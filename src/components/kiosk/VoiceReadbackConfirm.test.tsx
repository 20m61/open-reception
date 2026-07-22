import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceReadbackConfirm } from './VoiceReadbackConfirm';
import type { VoiceKioskState } from '@/domain/voice-session/kiosk-view';

function render(state: VoiceKioskState, locale: 'ja' | 'en' | 'ko' | 'zh' = 'ja') {
  return renderToStaticMarkup(
    <VoiceReadbackConfirm state={state} locale={locale} onYes={() => {}} onNo={() => {}} />,
  );
}

describe('VoiceReadbackConfirm (#361 音声復唱 UI / #364 字幕・インジケータ)', () => {
  it('inactive では何も描画しない（音声モード未注入時は完全に不可視 = 退行なし）', () => {
    expect(render({ mode: 'inactive' })).toBe('');
  });

  it('活性時は voice-layer を出し、現在 mode を data 属性で公開する（アバター口パク等の結線点）', () => {
    const html = render({ mode: 'listening' });
    expect(html).toContain('data-testid="voice-layer"');
    expect(html).toContain('data-voice-mode="listening"');
  });

  it('listening/speaking/ducked は字幕（caption）を出す', () => {
    expect(render({ mode: 'listening' })).toContain('data-testid="voice-caption"');
    expect(render({ mode: 'speaking' })).toContain('ご案内しています');
    expect(render({ mode: 'ducked' })).toContain('どうぞ');
  });

  it('復唱確認は「◯◯様ですね？」と はい/いいえ を出す（担当者名を補間）', () => {
    const html = render({ mode: 'readback', readbackName: '佐藤', readbackReason: 'low_entity_confidence' });
    expect(html).toContain('data-testid="voice-readback"');
    expect(html).toContain('佐藤様ですね？');
    expect(html).toContain('data-testid="voice-confirm-yes"');
    expect(html).toContain('data-testid="voice-confirm-no"');
    expect(html).toContain('はい');
    expect(html).toContain('いいえ');
  });

  it('復唱は 4 言語で描画できる（i18n）', () => {
    expect(render({ mode: 'readback', readbackName: 'Sato', readbackReason: 'low_stt_confidence' }, 'en')).toContain('Do you mean Sato?');
    expect(render({ mode: 'readback', readbackName: '사토', readbackReason: 'low_stt_confidence' }, 'ko')).toContain('사토님이 맞으신가요?');
    expect(render({ mode: 'readback', readbackName: '佐藤', readbackReason: 'low_stt_confidence' }, 'zh')).toContain('您是找佐藤吗？');
  });

  it('障害時はタッチ縮退案内を出す（4 言語）', () => {
    const ja = render({ mode: 'fallback', fallbackSource: 'stt' });
    expect(ja).toContain('data-testid="voice-fallback-notice"');
    expect(ja).toContain('画面のタッチ');
    expect(render({ mode: 'fallback', fallbackSource: 'stt' }, 'en')).toContain('continue by touch');
  });

  it('lang 属性を locale から付与する（CJK/スクリーンリーダ対応）', () => {
    expect(render({ mode: 'listening' }, 'ko')).toContain('lang="ko"');
  });

  it('字幕は aria-live（polite）で読み上げられる（視覚に頼らない案内）', () => {
    expect(render({ mode: 'listening' })).toContain('aria-live="polite"');
  });
});

describe('聞き取り中インジケータ + interim 逐次字幕（#361/#364 第11wave [C]）', () => {
  it('listening 中はインジケータを出し、interim 未着は data-stage="idle"（話しかけ待ち）', () => {
    const html = render({ mode: 'listening' });
    expect(html).toContain('data-testid="voice-listening-indicator"');
    expect(html).toContain('data-stage="idle"');
    // 話しかけ待ちの静的プロンプト（お話しください）を維持
    expect(html).toContain('data-testid="voice-caption"');
    expect(html).toContain('お話しください');
  });

  it('interim があると data-stage="speech"（発話検知中）で逐次字幕テキストを表示し、静的プロンプトは出さない', () => {
    const html = render({ mode: 'listening', interimText: 'さとう' });
    expect(html).toContain('data-testid="voice-listening-indicator"');
    expect(html).toContain('data-stage="speech"');
    expect(html).toContain('data-testid="voice-interim"');
    expect(html).toContain('さとう');
    // interim を主字幕にするため静的プロンプト（voice-caption）は重複させない
    expect(html).not.toContain('data-testid="voice-caption"');
  });

  it('interim 字幕は aria-live=polite で読み上げる（PII は表示のみ・ログ/eval へ出さない）', () => {
    const html = render({ mode: 'listening', interimText: 'さと' });
    // interim ブロックが aria-live polite を持つ
    expect(html).toMatch(/data-testid="voice-interim"[^>]*aria-live="polite"/);
  });

  it('インジケータは装飾のため aria-hidden（意味論は字幕側が担う）', () => {
    expect(render({ mode: 'listening' })).toMatch(/data-testid="voice-listening-indicator"[^>]*aria-hidden="true"/);
  });

  it('listening 以外（speaking/readback）ではインジケータも interim も出さない', () => {
    expect(render({ mode: 'speaking' })).not.toContain('data-testid="voice-listening-indicator"');
    expect(render({ mode: 'readback', readbackName: '佐藤', readbackReason: 'low_stt_confidence' })).not.toContain('data-testid="voice-interim"');
  });
});
