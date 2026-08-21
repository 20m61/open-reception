/**
 * webhook 応答までの段ごとの所要時間 (#744)。
 */
import { describe, expect, it } from 'vitest';
import { createStageRecorder, stageTimingLog, WEBHOOK_STAGES } from './stage-timing';

function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe('createStageRecorder (#744)', () => {
  it('段ごとの所要時間と合計を返す', async () => {
    // start=0, from=0, after=30, from=30, after=100, finish=100
    const recorder = createStageRecorder('choice', clock([0, 0, 30, 30, 100, 100]));
    await recorder.measure('signature', async () => 'a');
    await recorder.measure('provider_initiate', async () => 'b');
    const t = recorder.finish();
    expect(t.route).toBe('choice');
    expect(t.stages.signature).toBe(30);
    expect(t.stages.provider_initiate).toBe(70);
    expect(t.totalMs).toBe(100);
  });

  /**
   * 🔴 **失敗した段も測る。** 遅いのが失敗経路（発信のタイムアウト等）だと分からないと、
   * どこを直せばいいか切り分けられない。
   */
  it('🔴 例外で終わった段も測り、例外はそのまま上へ返す', async () => {
    const recorder = createStageRecorder('choice', clock([0, 0, 50, 50]));
    await expect(
      recorder.measure('provider_initiate', async () => {
        throw new Error('TEST-slow');
      }),
    ).rejects.toThrow('TEST-slow');
    expect(recorder.finish().stages.provider_initiate).toBe(50);
  });

  it('測っていない段は載せない（欠測と 0ms を区別する）', async () => {
    const recorder = createStageRecorder('choice', clock([0, 0, 10, 10]));
    await recorder.measure('signature', async () => undefined);
    const t = recorder.finish();
    expect(t.stages.signature).toBe(10);
    expect(t.stages.provider_initiate).toBeUndefined();
  });
});

describe('stageTimingLog (#744)', () => {
  it('段名と所要ミリ秒だけを出す（PII・通話 ID を載せない）', async () => {
    const recorder = createStageRecorder('choice', clock([0, 0, 5, 5]));
    await recorder.measure('correlation_write', async () => undefined);
    const line = stageTimingLog(recorder.finish());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('vonage_webhook_timing');
    expect(Object.keys(parsed).sort()).toEqual(['event', 'route', 'stages', 'totalMs']);
  });

  /**
   * 🔴 段名は**列挙**であること。呼び出し側が任意の文字列を書けると、
   * そこへ選択の値や宛先が混ざりうる。
   */
  it('🔴 段名に外部入力を混ぜられない（列挙で固定）', () => {
    expect(WEBHOOK_STAGES).toContain('provider_initiate');
    for (const stage of WEBHOOK_STAGES) {
      expect(stage).toMatch(/^[a-z_]+$/);
    }
  });
});
