import { describe, expect, it } from 'vitest';
import { parseCallStages, type CallStage } from './call-stages';

describe('parseCallStages (#363 取次段階イベントの後方互換抽出)', () => {
  it('旧形（stages 無し）の /call 応答は空配列を返す（#363 Mock が旧形で返しても壊れない）', () => {
    expect(parseCallStages({ state: 'connected' })).toEqual([]);
    expect(parseCallStages({ state: 'calling' })).toEqual([]);
  });

  it('null/非オブジェクト/配列外は空配列（防御的）', () => {
    expect(parseCallStages(null)).toEqual([]);
    expect(parseCallStages(undefined)).toEqual([]);
    expect(parseCallStages(42)).toEqual([]);
    expect(parseCallStages({ state: 'calling', stages: 'x' })).toEqual([]);
  });

  it('新形の stages[] を key/status で抽出する', () => {
    const parsed = parseCallStages({
      state: 'calling',
      stages: [
        { key: 'dialing', status: 'done' },
        { key: 'ringing', status: 'active' },
        { key: 'connecting', status: 'pending' },
      ],
    });
    expect(parsed).toEqual<CallStage[]>([
      { key: 'dialing', status: 'done' },
      { key: 'ringing', status: 'active' },
      { key: 'connecting', status: 'pending' },
    ]);
  });

  it('status 欠落/不正は pending へ既定化する', () => {
    expect(parseCallStages({ stages: [{ key: 'dialing' }, { key: 'ringing', status: 'bogus' }] })).toEqual<
      CallStage[]
    >([
      { key: 'dialing', status: 'pending' },
      { key: 'ringing', status: 'pending' },
    ]);
  });

  it('PII 混入防止: key は英数字/._- のみ許容し、それ以外を含む/空/非文字列の要素は捨てる', () => {
    const parsed = parseCallStages({
      stages: [
        { key: 'stage_1', status: 'done' },
        { key: '山田 太郎', status: 'active' }, // 氏名らしき値は捨てる
        { key: 'a b', status: 'active' }, // 空白混入は捨てる
        { key: '', status: 'active' },
        { key: 42, status: 'active' },
        { key: 'ok-2.3', status: 'active' },
      ],
    });
    expect(parsed).toEqual<CallStage[]>([
      { key: 'stage_1', status: 'done' },
      { key: 'ok-2.3', status: 'active' },
    ]);
  });

  it('要素数は上限（8）で打ち切る（表示暴走防止）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `s${i}`, status: 'pending' as const }));
    expect(parseCallStages({ stages: many })).toHaveLength(8);
  });
});
