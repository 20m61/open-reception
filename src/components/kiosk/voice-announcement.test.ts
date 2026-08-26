/**
 * 読み上げ文言の決定 (#803)。効果（useEffect）で観測できない部分を純関数として縛る。
 */
import { describe, expect, it } from 'vitest';
import { announcementPhrase, shouldAnnounce } from './voice-announcement';
import { captionKeyFor, type VoiceKioskState } from '@/domain/voice-session/kiosk-view';
import { makeT } from '@/lib/i18n';

const NOTICE: VoiceKioskState = { mode: 'unavailable', readbackName: '佐藤' };

describe('読み上げ文言 (#803)', () => {
  it('字幕とまったく同じ文言を返す（表示と読み上げが一致する）', () => {
    const captionKey = captionKeyFor(NOTICE);
    expect(captionKey).not.toBeNull();
    expect(announcementPhrase(NOTICE, 'ja')).toBe(
      makeT('ja')(captionKey!, { name: '佐藤' }),
    );
  });

  it('担当者名を差し込む（「は現在不在です」と喋らない）', () => {
    const phrase = announcementPhrase(NOTICE, 'ja');
    expect(phrase).toContain('佐藤');
    // 次の手も言う。理由だけ告げて次が無いと、来訪者は待合で止まる。
    expect(phrase).toContain('部署');
    expect(phrase).toContain('代表窓口');
  });

  it.each(['en', 'ko', 'zh'] as const)('%s でも名前を落とさない', (locale) => {
    expect(announcementPhrase(NOTICE, locale)).toContain('佐藤');
  });

  /** 下界: 状態表示の字幕を読み上げると来訪者の発話にかぶる。 */
  it.each(['listening', 'speaking', 'ducked', 'readback', 'fallback', 'idle'] as const)(
    '%s では何も返さない',
    (mode) => {
      expect(announcementPhrase({ mode, readbackName: '佐藤' }, 'ja')).toBeNull();
    },
  );
});

describe('読み上げの発火判定 (#803)', () => {
  it('告知へ入ったら読み上げる', () => {
    expect(shouldAnnounce({ mode: 'listening' }, NOTICE)).toBe(true);
    expect(shouldAnnounce(null, NOTICE)).toBe(true);
  });

  it('同じ局面のまま再描画しても読み上げ直さない', () => {
    expect(shouldAnnounce(NOTICE, NOTICE)).toBe(false);
  });

  /**
   * 🔴 **同じ名前で再入したら、もう一度言う。** 文言をキーにすると 2 度目が黙り、
   * 言い直した来訪者に沈黙で返すことになる（#803 が塞ぎたかった状況そのもの）。
   */
  it('同じ名前でも別の dispatch なら読み上げ直す', () => {
    const again: VoiceKioskState = { mode: 'unavailable', readbackName: '佐藤' };
    expect(again).toEqual(NOTICE);
    expect(shouldAnnounce(NOTICE, again)).toBe(true);
  });

  it('読み上げるものが無い局面では発火しない', () => {
    expect(shouldAnnounce(NOTICE, { mode: 'listening' })).toBe(false);
  });
});
