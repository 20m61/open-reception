import { describe, expect, it } from 'vitest';
import type { KioskFlow as KioskCustomFlow } from './custom-flow/types';
import {
  VISITOR_NAME_NOTICE_TIMEOUT_MS,
  customFlowAcceptsVoiceName,
  isVisitorNameVoiceEligible,
  speakUntilEnd,
} from './visitor-name-voice';
import { resolvePrivacyNoticeSpeech } from './privacy-notice';

/** 音声で氏名を聞くかの判定と、通知の読み上げ (ADR 0011 §2・§3-c・§5、#1290)。合成データだけを使う。 */
const base = { ttsEnabled: true, locale: 'ja' as const, returnedWithName: false, hasNameField: true };

describe('isVisitorNameVoiceEligible', () => {
  it('TTS が有効・日本語・氏名の欄があり・確認から戻っていないときだけ聞く', () => {
    expect(isVisitorNameVoiceEligible(base)).toBe(true);
    expect(isVisitorNameVoiceEligible({ ...base, locale: 'ja-simple' })).toBe(true);
  });

  it.each([
    ['TTS が無効（通知を読み上げられない）', { ttsEnabled: false }],
    ['確認画面から戻った（氏名が入っている）', { returnedWithName: true }],
    ['氏名の欄が無いカスタムフロー', { hasNameField: false }],
    ['日本語以外（名乗りの抽出器と「はい／いいえ」が日本語だけ）', { locale: 'en' as const }],
    ['韓国語', { locale: 'ko' as const }],
    ['中国語', { locale: 'zh' as const }],
  ])('%s なら聞かない', (_, override) => {
    expect(isVisitorNameVoiceEligible({ ...base, ...override })).toBe(false);
  });
});

describe('customFlowAcceptsVoiceName（§5）', () => {
  const flow = (over: Partial<KioskCustomFlow>): KioskCustomFlow => ({
    id: 'f',
    purposeKey: 'p',
    displayName: '面会',
    order: 0,
    steps: ['visitorInfo', 'confirm'],
    fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    ...over,
  });

  it('visitorInfo の step と、text の name の欄があるときだけ', () => {
    expect(customFlowAcceptsVoiceName(flow({}))).toBe(true);
    expect(customFlowAcceptsVoiceName(flow({ steps: ['confirm'] }))).toBe(false);
    expect(customFlowAcceptsVoiceName(flow({ fields: [] }))).toBe(false);
    expect(
      customFlowAcceptsVoiceName(flow({ fields: [{ key: 'name', label: 'お名前', type: 'select', required: true }] })),
    ).toBe(false);
    expect(
      customFlowAcceptsVoiceName(flow({ fields: [{ key: 'company', label: '会社', type: 'text', required: true }] })),
    ).toBe(false);
  });
});

describe('speakUntilEnd（読み上げの終了と失敗を区別する）', () => {
  function fakeTimer() {
    let fire: (() => void) | null = null;
    let ms: number | null = null;
    return {
      timer: (fn: () => void, wait: number) => {
        fire = fn;
        ms = wait;
        return () => {
          fire = null;
        };
      },
      fire: () => fire?.(),
      get ms() {
        return ms;
      },
    };
  }

  it('最後まで読み終えたら true', async () => {
    const t = fakeTimer();
    const result = speakUntilEnd((_, events) => events.onEnd?.(), '通知', t.timer);
    await expect(result).resolves.toBe(true);
  });

  it('失敗・中断（onError）は false', async () => {
    const t = fakeTimer();
    await expect(speakUntilEnd((_, events) => events.onError?.(), '通知', t.timer)).resolves.toBe(false);
  });

  it('終了の通知が来ないまま時間が過ぎたら false（TTS が無効・iPad で onend が来ない）', async () => {
    const t = fakeTimer();
    const result = speakUntilEnd(() => {}, '通知', t.timer);
    expect(t.ms).toBe(VISITOR_NAME_NOTICE_TIMEOUT_MS);
    t.fire();
    await expect(result).resolves.toBe(false);
  });

  it('時間切れの後に遅れて終了が来ても true にしない（最初の結果だけ）', async () => {
    const t = fakeTimer();
    let end: (() => void) | undefined;
    const result = speakUntilEnd((_, events) => {
      end = events.onEnd;
    }, '通知', t.timer);
    t.fire();
    end?.();
    await expect(result).resolves.toBe(false);
  });

  it('読み上げが例外を投げても false', async () => {
    const t = fakeTimer();
    await expect(
      speakUntilEnd(() => {
        throw new Error('tts');
      }, '通知', t.timer),
    ).resolves.toBe(false);
  });
});

describe('resolvePrivacyNoticeSpeech（固定の前置き＋要約、§2）', () => {
  it('上書きが無ければ、前置き＋短い版', () => {
    const text = resolvePrivacyNoticeSpeech('ja', {});
    expect(text).toContain('お名前をお伺いします');
    expect(text).toContain('画面から入力できます');
    expect(text).toContain('記録には保存しません');
  });

  it('テナントの上書きがあれば、前置き＋上書き（前置きは必ず読む）', () => {
    const text = resolvePrivacyNoticeSpeech('ja', { overrideSummary: '  当社の規程に従い取り扱います。 ' });
    expect(text.startsWith('受付のため、お名前をお伺いします。')).toBe(true);
    expect(text.endsWith('当社の規程に従い取り扱います。')).toBe(true);
  });

  it('上書きが空白だけなら短い版', () => {
    expect(resolvePrivacyNoticeSpeech('ja', { overrideSummary: '  ' })).toBe(resolvePrivacyNoticeSpeech('ja', {}));
  });
});
