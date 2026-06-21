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
