import { describe, expect, it } from 'vitest';
import { shouldShowVrmFallback } from './fallback-state';

describe('shouldShowVrmFallback (#932)', () => {
  it('vrmUrl が無ければ fallback（WebGL を初期化しない）', () => {
    expect(shouldShowVrmFallback({ vrmUrl: undefined })).toBe(true);
    expect(shouldShowVrmFallback({ vrmUrl: '' })).toBe(true);
  });

  it('失敗した URL を表示しようとしている間は fallback', () => {
    expect(shouldShowVrmFallback({ vrmUrl: '/a.vrm', failedUrl: '/a.vrm' })).toBe(true);
  });

  /**
   * 🔴 **本 issue の核。** 失敗を持ち越さない。以前は `failed: boolean` だったため
   * URL を差し替えても真のままで、端末が再読込まで静止画から戻らなかった。
   */
  it('別の URL へ差し替えたら fallback をやめる（復帰する）', () => {
    expect(shouldShowVrmFallback({ vrmUrl: '/b.vrm', failedUrl: '/a.vrm' })).toBe(false);
  });

  /**
   * **下界**（`.claude/rules/opus5-autonomous-loop.md`「不変条件は片側しか主張しない」）。
   * 上だけだと「常に false」でも通る。失敗していない状態で fallback にしないことを併せて縛る。
   */
  it('まだ失敗していなければ fallback にしない', () => {
    expect(shouldShowVrmFallback({ vrmUrl: '/a.vrm' })).toBe(false);
    expect(shouldShowVrmFallback({ vrmUrl: '/a.vrm', failedUrl: undefined })).toBe(false);
  });

  /** 同一 URL の自動リトライは対象外（#932 Non-goals）。同じ URL は失敗したままにする。 */
  it('同じ URL のままなら fallback を維持する（勝手に再試行しない）', () => {
    const input = { vrmUrl: '/a.vrm', failedUrl: '/a.vrm' };
    expect(shouldShowVrmFallback(input)).toBe(true);
    expect(shouldShowVrmFallback(input)).toBe(true);
  });

  /** 部分一致で誤判定しない（クエリ違いは別 URL）。 */
  it('前方一致する別 URL は別物として扱う', () => {
    expect(shouldShowVrmFallback({ vrmUrl: '/a.vrm?v=2', failedUrl: '/a.vrm' })).toBe(false);
  });
});
