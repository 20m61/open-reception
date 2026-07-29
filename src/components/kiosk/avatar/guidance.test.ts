import { describe, expect, it } from 'vitest';
import { AVATAR_STATES, RECEPTION_STATES, deriveAvatarState } from '@/domain/reception/ui-contract';
import type { AvatarState } from '@/domain/reception/ui-contract';
import { MOTION_KEYS } from '@/domain/motion/types';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import {
  AVATAR_EXPRESSIONS,
  AVATAR_GUIDANCE_CUES,
  avatarGuidanceFor,
  isResolvableMotionKey,
} from './guidance';

describe('avatarGuidanceFor — avatarState → 発話/字幕/モーション写像', () => {
  it('全 avatarState に提示内容が定義されている（漏れがない）', () => {
    for (const state of AVATAR_STATES) {
      const g = avatarGuidanceFor(state);
      expect(g.avatarState).toBe(state);
      expect(g.speech.length).toBeGreaterThan(0);
      expect(g.subtitle.length).toBeGreaterThan(0);
      expect(AVATAR_EXPRESSIONS).toContain(g.expression);
      expect(AVATAR_GUIDANCE_CUES).toContain(g.cue);
    }
  });

  it('発話と字幕は常に同一（音声が無くても字幕で同内容を保証する不変条件）', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const state of AVATAR_STATES) {
        const g = avatarGuidanceFor(state, locale);
        expect(g.subtitle).toBe(g.speech);
      }
    }
  });

  it('モーションキーは #31 の語彙（MOTION_KEYS / resolveMotionUrl が消費可能）に含まれる', () => {
    for (const state of AVATAR_STATES) {
      const g = avatarGuidanceFor(state);
      expect(MOTION_KEYS).toContain(g.motionKey);
      expect(isResolvableMotionKey(g.motionKey)).toBe(true);
    }
  });

  it('アバターは短文に保つ（過剰に喋らない: 既定 locale で 60 文字以内）', () => {
    for (const state of AVATAR_STATES) {
      const g = avatarGuidanceFor(state);
      expect(g.speech.length).toBeLessThanOrEqual(60);
    }
  });

  it('idle は AI 受付であることを自然に明示する（初期体験で AI 受付と分かる）', () => {
    expect(avatarGuidanceFor('idle', 'ja').speech).toContain('AI');
    expect(avatarGuidanceFor('idle', 'en').speech).toContain('AI');
  });
});

describe('avatarGuidanceFor — フォールバック', () => {
  it('VRM/静止画とも使えない最終フォールバックの fallbackText が現在状態の字幕と一致する', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const state of AVATAR_STATES) {
        const g = avatarGuidanceFor(state, locale);
        expect(g.fallbackText).toBe(g.subtitle);
        expect(g.fallbackText.length).toBeGreaterThan(0);
      }
    }
  });

  it('未対応 locale は既定 locale (ja) の文言へフォールバックする', () => {
    const fr = avatarGuidanceFor('idle', 'fr-FR' as unknown as Locale);
    const ja = avatarGuidanceFor('idle', 'ja');
    expect(fr.speech).toBe(ja.speech);
  });

  it('locale 別辞書に欠落があっても既定 locale で必ず非空文字になる', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const state of AVATAR_STATES) {
        expect(avatarGuidanceFor(state, locale).speech.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('avatarGuidanceFor — 多言語', () => {
  it('対応 locale ごとに固有の文言を返す（少なくとも idle で言語差がある）', () => {
    const ja = avatarGuidanceFor('idle', 'ja').speech;
    const en = avatarGuidanceFor('idle', 'en').speech;
    const ko = avatarGuidanceFor('idle', 'ko').speech;
    const zh = avatarGuidanceFor('idle', 'zh').speech;
    expect(new Set([ja, en, ko, zh]).size).toBe(4);
  });

  it('locale を変えても表情/モーション/誘導（表現）は不変（言語非依存）', () => {
    for (const state of AVATAR_STATES) {
      const base = avatarGuidanceFor(state, 'ja');
      for (const locale of SUPPORTED_LOCALES) {
        const g = avatarGuidanceFor(state, locale);
        expect(g.expression).toBe(base.expression);
        expect(g.motionKey).toBe(base.motionKey);
        expect(g.cue).toBe(base.cue);
      }
    }
  });
});

describe('screenState → avatarState → guidance の整合 (#120 contract 消費)', () => {
  it('全 screenState から導出した avatarState に必ず guidance がある', () => {
    for (const screen of RECEPTION_STATES) {
      const avatarState = deriveAvatarState(screen);
      const g = avatarGuidanceFor(avatarState);
      expect(g.avatarState).toBe(avatarState);
      expect(g.speech.length).toBeGreaterThan(0);
    }
  });

  it('呼び出し中(calling)/失敗系(apologizing)では誘導が操作を急かさない種類になっている', () => {
    expect(avatarGuidanceFor('calling').cue).toBe('reassure');
    expect(avatarGuidanceFor('apologizing').cue).toBe('offerAlternative');
    // 通話中は能動的な操作誘導を出さない。
    expect(avatarGuidanceFor('connected').cue).toBe('none');
  });

  it('失敗系の screenState (failed/timeout/fallback) は代替案内へ誘導する', () => {
    for (const screen of ['failed', 'timeout'] as const) {
      const avatarState: AvatarState = deriveAvatarState(screen);
      expect(avatarGuidanceFor(avatarState).cue).toBe('offerAlternative');
    }
  });
});

describe('avatarGuidanceFor — overrides (#323 呼び出し中の段階的ケア)', () => {
  it('overrides.text を渡すと speech/subtitle/fallbackText が全てその文言になる（不変条件を保つ）', () => {
    const g = avatarGuidanceFor('calling', 'ja', { text: 'もう少しお待ちください' });
    expect(g.speech).toBe('もう少しお待ちください');
    expect(g.subtitle).toBe('もう少しお待ちください');
    expect(g.fallbackText).toBe('もう少しお待ちください');
  });

  it('overrides.expression を渡すと表情のみ上書きし、motionKey/cue は avatarState 標準のまま', () => {
    const base = avatarGuidanceFor('calling', 'ja');
    const g = avatarGuidanceFor('calling', 'ja', { expression: 'concerned' });
    expect(g.expression).toBe('concerned');
    expect(g.motionKey).toBe(base.motionKey);
    expect(g.cue).toBe(base.cue);
    // text を上書きしていないので文言は既定のまま。
    expect(g.speech).toBe(base.speech);
  });

  it('overrides を渡さない場合は既存の挙動と完全に一致する（後方互換）', () => {
    for (const state of AVATAR_STATES) {
      expect(avatarGuidanceFor(state, 'ja', undefined)).toEqual(avatarGuidanceFor(state, 'ja'));
    }
  });

  it('avatarState 自体は overrides の影響を受けない（状態機械/契約を汚さない）', () => {
    const g = avatarGuidanceFor('calling', 'ja', { text: 'つながらない場合は別の方法でご案内します', expression: 'concerned' });
    expect(g.avatarState).toBe('calling');
  });
});

describe('avatarGuidanceFor — 受付内での位置づけ (#422 inc5-c 増分 1)', () => {
  // ステッパー（目的→相手→情報→確認の 4 段表示）を廃止したので、「今どこか・あとどれだけか」
  // は字幕が担う。数字ではなく会話で伝える（#422 の会話ターン中心化）。
  //
  // **位置づけを入れるのは screenState と 1 対 1 の avatarState だけ。**
  // `guiding` は selectingTarget（相手選択＝ 2 番目）と fallback（代替案内＝受付失敗後）の
  // 両方を覆うため、「つぎに」を入れると代替案内画面へ漏れる（#489 で gazeTarget と cue に
  // ついて見つけたのと同じ粗さの問題）。
  const POSITIONAL: ReadonlyArray<{ state: AvatarState; marker: RegExp }> = [
    { state: 'greeting', marker: /まず/ },
    { state: 'listening', marker: /あと少し/ },
    { state: 'confirming', marker: /最後/ },
  ];

  it('入口・入力・確認の字幕が受付内での位置づけを含む（ja）', () => {
    for (const { state, marker } of POSITIONAL) {
      expect(avatarGuidanceFor(state, 'ja').subtitle, state).toMatch(marker);
    }
  });

  it('guiding には位置づけを入れない（selectingTarget と fallback を兼ねるため）', () => {
    // 代替案内画面（fallback）で「つぎに」と言わないことの回帰防止。
    expect(deriveAvatarState('selectingTarget')).toBe('guiding');
    expect(deriveAvatarState('fallback')).toBe('guiding');
    expect(avatarGuidanceFor('guiding', 'ja').subtitle).not.toMatch(/まず|つぎ|次に|あと少し|最後/);
  });

  it('全 locale で位置づけ表現が入る（ja へ落ちるだけの locale を残さない）', () => {
    // 字幕は常設表示の主要導線。位置づけだけ ja に落ちると、その言語の来訪者には
    // 進捗が伝わらないまま常設要素だけ減ったことになる。
    for (const locale of SUPPORTED_LOCALES) {
      for (const { state } of POSITIONAL) {
        const subtitle = avatarGuidanceFor(state, locale).subtitle;
        const jaSubtitle = avatarGuidanceFor(state, 'ja').subtitle;
        if (locale === 'ja') continue;
        expect(subtitle, `${locale}/${state}`).not.toBe(jaSubtitle);
      }
    }
  });

  it('位置づけを足しても短文のまま（既定 locale で 60 文字以内）', () => {
    for (const { state } of POSITIONAL) {
      expect(avatarGuidanceFor(state, 'ja').subtitle.length, state).toBeLessThanOrEqual(60);
    }
  });
});
