import { describe, expect, it } from 'vitest';
import { sanitizeReceptionExperience } from './log';

describe('sanitizeReceptionExperience (#319)', () => {
  it('既知キーのみを型検査して取り込む', () => {
    const out = sanitizeReceptionExperience({
      stepDurations: { selectingPurpose: 1000, calling: 200 },
      timeToCallMs: 15000,
      backCount: 2,
      cancelCount: 1,
      inputMethod: 'chat',
      abandonedAtStep: 'confirming',
    });
    expect(out).toEqual({
      stepDurations: { selectingPurpose: 1000, calling: 200 },
      timeToCallMs: 15000,
      backCount: 2,
      cancelCount: 1,
      inputMethod: 'chat',
      abandonedAtStep: 'confirming',
    });
  });

  it('未知キー・PII らしきキーを破棄する（ホワイトリスト）', () => {
    const out = sanitizeReceptionExperience({
      timeToCallMs: 5000,
      name: '来客 一郎',
      company: 'ACME',
      note: '内密',
      extra: { anything: true },
    } as unknown);
    expect(out).toEqual({ timeToCallMs: 5000 });
    expect(JSON.stringify(out)).not.toContain('来客');
    expect(JSON.stringify(out)).not.toContain('ACME');
  });

  it('不正値を弾く（非数値・負数・0 の回数・未知の列挙値・未知ステップ）', () => {
    const out = sanitizeReceptionExperience({
      stepDurations: { selectingPurpose: -1, selectingTarget: 'x', confirming: 3, bogus: 9 },
      timeToCallMs: NaN,
      backCount: 0, // 0 は省略
      cancelCount: -3, // 負は省略
      inputMethod: 'keyboard', // 未知列挙
      abandonedAtStep: 'nowhere', // 未知ステップ
    } as unknown);
    expect(out).toEqual({ stepDurations: { confirming: 3 } });
  });

  it('有効な値が無ければ undefined（破損・空・非オブジェクトを保存しない）', () => {
    expect(sanitizeReceptionExperience(undefined)).toBeUndefined();
    expect(sanitizeReceptionExperience(null)).toBeUndefined();
    expect(sanitizeReceptionExperience('nope')).toBeUndefined();
    expect(sanitizeReceptionExperience({})).toBeUndefined();
    expect(sanitizeReceptionExperience({ unknownOnly: 1 })).toBeUndefined();
    expect(sanitizeReceptionExperience({ backCount: 0 })).toBeUndefined();
  });
});
