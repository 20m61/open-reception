/**
 * `calling` をどの媒体で待つか (#4 Inc D-2 項目 2)。
 *
 * `'calling'` は 2 つの意味を持つようになった:
 *   - **video**: Vonage Video セッションが確立し、担当者の参加を待っている
 *   - **pstn**:  実 PSTN 発信を撃ち、応答を provider webhook で待っている
 *
 * 見分けないと、電話を鳴らしただけの受付でビデオビューが開く（セッションが無いので繋がらない）。
 */
import { describe, expect, it } from 'vitest';
import { shouldOpenVideoView } from './call-medium';

describe('shouldOpenVideoView — calling の媒体を見分ける', () => {
  it('ビデオセッションが在れば video ビューを開く', () => {
    expect(shouldOpenVideoView({ state: 'calling', vonageSessionId: 'sess-1' })).toBe(true);
  });

  it('🔴 セッションが無い calling（実 PSTN 発信）では開かない', () => {
    // 開くと、存在しないビデオセッションのトークンを取りに行って失敗する。
    expect(shouldOpenVideoView({ state: 'calling' })).toBe(false);
    expect(shouldOpenVideoView({ state: 'calling', vonageSessionId: undefined })).toBe(false);
    expect(shouldOpenVideoView({ state: 'calling', vonageSessionId: null })).toBe(false);
  });

  it('🔴 空文字は「セッションがある」ではない', () => {
    // `?? ''` や `|| ''` を経由した値が「設定済み」に化けるのを防ぐ。
    expect(shouldOpenVideoView({ state: 'calling', vonageSessionId: '' })).toBe(false);
    expect(shouldOpenVideoView({ state: 'calling', vonageSessionId: '   ' })).toBe(false);
  });

  it.each(['connected', 'timeout', 'failed', 'confirming', 'completed'])(
    'calling 以外（%s）では開かない',
    (state) => {
      expect(shouldOpenVideoView({ state, vonageSessionId: 'sess-1' })).toBe(false);
    },
  );
});
