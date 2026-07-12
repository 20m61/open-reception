import { describe, expect, it } from 'vitest';
import { resultToneForState } from './result-tone';

/**
 * 結果/待ち画面の共通レイアウト (#326 L1) が使うトーン判定。
 * アイコン色・パネルの縁取りに使い、状態を一目で伝える（受け入れ条件:
 * 「成功/失敗のトーンが伝わる」）。
 */
describe('resultToneForState (#326)', () => {
  it('成功系（応答/完了）は success', () => {
    expect(resultToneForState('connected')).toBe('success');
    expect(resultToneForState('completed')).toBe('success');
  });

  it('失敗系（未応答/失敗）は danger', () => {
    expect(resultToneForState('timeout')).toBe('danger');
    expect(resultToneForState('failed')).toBe('danger');
  });

  it('代替導線（fallback）は warning', () => {
    expect(resultToneForState('fallback')).toBe('warning');
  });

  it('呼び出し中/キャンセルは中立の info', () => {
    expect(resultToneForState('calling')).toBe('info');
    expect(resultToneForState('cancelled')).toBe('info');
  });

  it('対象外の状態（選択/入力/確認/待機）は info にフォールバックする', () => {
    expect(resultToneForState('idle')).toBe('info');
    expect(resultToneForState('selectingPurpose')).toBe('info');
    expect(resultToneForState('selectingTarget')).toBe('info');
    expect(resultToneForState('inputVisitorInfo')).toBe('info');
    expect(resultToneForState('confirming')).toBe('info');
  });
});
