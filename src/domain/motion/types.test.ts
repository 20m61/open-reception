import { describe, expect, it } from 'vitest';
import { motionKeyForState, resolveMotionAssetId, resolveMotionUrl } from './types';

describe('motionKeyForState (#31)', () => {
  it('主要な受付状態をモーションキーに対応づける', () => {
    expect(motionKeyForState('idle')).toBe('idle');
    expect(motionKeyForState('calling')).toBe('calling');
    expect(motionKeyForState('connected')).toBe('connected');
    expect(motionKeyForState('failed')).toBe('failed');
    expect(motionKeyForState('timeout')).toBe('timeout');
    expect(motionKeyForState('completed')).toBe('success');
    expect(motionKeyForState('fallback')).toBe('fallback');
  });

  it('キャンセルは待機モーション', () => {
    expect(motionKeyForState('cancelled')).toBe('idle');
  });
});

describe('resolveMotionAssetId (#31)', () => {
  it('割り当て済みキーはそのアセット', () => {
    expect(resolveMotionAssetId('calling', { calling: 'm1' }, 'def')).toBe('m1');
  });
  it('未設定キーは default に fallback', () => {
    expect(resolveMotionAssetId('failed', {}, 'def')).toBe('def');
  });
  it('default も無ければ undefined（受付画面は壊さない）', () => {
    expect(resolveMotionAssetId('failed', {})).toBeUndefined();
  });
});

describe('resolveMotionUrl (#31)', () => {
  it('割り当て済みキーはその URL', () => {
    expect(resolveMotionUrl('calling', { calling: 'https://x/c.vrma' }, 'https://x/def.vrma')).toBe(
      'https://x/c.vrma',
    );
  });
  it('未設定キーは default URL に fallback', () => {
    expect(resolveMotionUrl('failed', {}, 'https://x/def.vrma')).toBe('https://x/def.vrma');
  });
  it('default も無ければ undefined（受付画面は壊さない）', () => {
    expect(resolveMotionUrl('failed', {})).toBeUndefined();
  });
});
