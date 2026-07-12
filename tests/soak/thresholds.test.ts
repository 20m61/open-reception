import { describe, expect, it } from 'vitest';
import {
  evaluateDomNodeGrowth,
  evaluateHeapGrowth,
  evaluateSoakRun,
  maxHeartbeatGap,
  parseSoakMode,
  type HeartbeatSampleLike,
  type MemorySampleLike,
} from './thresholds';

/**
 * soak ハーネスの純ロジック（モード解決・閾値判定）の unit test (issue #317)。
 * ブラウザ非依存にすることで --pr の unit ステップ（vitest）で高速に検証できる。
 * 実際の Playwright ループは tests/e2e/soak/*.spec.ts が担う（--pr では実行しない）。
 */

describe('parseSoakMode', () => {
  it('未指定は smoke（既定・短時間）を返す', () => {
    const config = parseSoakMode(undefined);
    expect(config.mode).toBe('smoke');
    expect(config.totalMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it.each(['smoke', '30m', '2h', '8h'] as const)('%s モードの totalMs は昇順に大きくなる', (mode) => {
    const config = parseSoakMode(mode);
    expect(config.mode).toBe(mode);
    expect(config.totalMs).toBeGreaterThan(0);
  });

  it('モードが進むほど totalMs も heap 閾値も厳しくなる（長時間ほど許容増加率を下げる）', () => {
    const smoke = parseSoakMode('smoke');
    const thirtyMin = parseSoakMode('30m');
    const twoHour = parseSoakMode('2h');
    const eightHour = parseSoakMode('8h');
    expect(smoke.totalMs).toBeLessThan(thirtyMin.totalMs);
    expect(thirtyMin.totalMs).toBeLessThan(twoHour.totalMs);
    expect(twoHour.totalMs).toBeLessThan(eightHour.totalMs);
    expect(smoke.maxHeapGrowthPercent).toBeGreaterThanOrEqual(thirtyMin.maxHeapGrowthPercent);
    expect(thirtyMin.maxHeapGrowthPercent).toBeGreaterThanOrEqual(twoHour.maxHeapGrowthPercent);
    expect(twoHour.maxHeapGrowthPercent).toBeGreaterThanOrEqual(eightHour.maxHeapGrowthPercent);
  });

  it('未知の文字列は smoke にフォールバックする', () => {
    const config = parseSoakMode('bogus');
    expect(config.mode).toBe('smoke');
  });
});

describe('evaluateHeapGrowth', () => {
  it('サンプル不足（1点以下）は null（判定不能）', () => {
    expect(evaluateHeapGrowth([{ timestamp: 0, usedJSHeapSize: 1000, domNodes: 10 }])).toBeNull();
  });

  it('増加率をパーセントで返す', () => {
    const samples: MemorySampleLike[] = [
      { timestamp: 0, usedJSHeapSize: 1000, domNodes: 10 },
      { timestamp: 1000, usedJSHeapSize: 1000, domNodes: 10 },
      { timestamp: 2000, usedJSHeapSize: 1500, domNodes: 10 },
    ];
    // 先頭1点はウォームアップとして除外 → baseline=1000(2点目), last=1500 → +50%
    expect(evaluateHeapGrowth(samples)).toBeCloseTo(50, 5);
  });

  it('usedJSHeapSize が取れない環境（performance.memory 非対応）は null 混じりでも安全に判定する', () => {
    const samples: MemorySampleLike[] = [
      { timestamp: 0, usedJSHeapSize: null, domNodes: 10 },
      { timestamp: 1000, usedJSHeapSize: null, domNodes: 10 },
    ];
    expect(evaluateHeapGrowth(samples)).toBeNull();
  });
});

describe('evaluateDomNodeGrowth', () => {
  it('DOM ノード増加率を返す', () => {
    const samples: MemorySampleLike[] = [
      { timestamp: 0, usedJSHeapSize: null, domNodes: 200 },
      { timestamp: 1000, usedJSHeapSize: null, domNodes: 200 },
      { timestamp: 2000, usedJSHeapSize: null, domNodes: 220 },
    ];
    expect(evaluateDomNodeGrowth(samples)).toBeCloseTo(10, 5);
  });
});

describe('maxHeartbeatGap', () => {
  it('全て成功していれば連続する成功間の最大間隔を返す', () => {
    const heartbeats: HeartbeatSampleLike[] = [
      { ok: true, timestamp: 0 },
      { ok: true, timestamp: 30_000 },
      { ok: true, timestamp: 65_000 },
    ];
    expect(maxHeartbeatGap(heartbeats)).toBe(35_000);
  });

  it('失敗を挟むと直近成功からの経過として最大間隔に反映される', () => {
    const heartbeats: HeartbeatSampleLike[] = [
      { ok: true, timestamp: 0 },
      { ok: false, timestamp: 30_000 },
      { ok: false, timestamp: 60_000 },
      { ok: true, timestamp: 95_000 },
    ];
    expect(maxHeartbeatGap(heartbeats)).toBe(95_000);
  });

  it('一度も成功していなければ Infinity', () => {
    const heartbeats: HeartbeatSampleLike[] = [
      { ok: false, timestamp: 0 },
      { ok: false, timestamp: 30_000 },
    ];
    expect(maxHeartbeatGap(heartbeats)).toBe(Infinity);
  });

  it('サンプルが無ければ null（判定不能）', () => {
    expect(maxHeartbeatGap([])).toBeNull();
  });
});

describe('evaluateSoakRun', () => {
  const baseInput = {
    mode: 'smoke' as const,
    memorySamples: [
      { timestamp: 0, usedJSHeapSize: 1_000_000, domNodes: 500 },
      { timestamp: 1000, usedJSHeapSize: 1_000_000, domNodes: 500 },
      { timestamp: 2000, usedJSHeapSize: 1_020_000, domNodes: 505 },
    ],
    heartbeats: [
      { ok: true, timestamp: 0 },
      { ok: true, timestamp: 30_000 },
    ],
    consoleErrors: [] as string[],
    expectedHeartbeatIntervalMs: 90_000,
    maxHeapGrowthPercent: 80,
  };

  it('健全なランは passed=true・reasons=[]', () => {
    const result = evaluateSoakRun(baseInput);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('console エラーが 1 件でもあれば FAIL する', () => {
    const result = evaluateSoakRun({ ...baseInput, consoleErrors: ['TypeError: boom'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('console'))).toBe(true);
  });

  it('heap 増加率が閾値超過なら FAIL する', () => {
    const result = evaluateSoakRun({
      ...baseInput,
      maxHeapGrowthPercent: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('heap'))).toBe(true);
  });

  it('heartbeat 欠落（間隔が閾値超過）なら FAIL する', () => {
    const result = evaluateSoakRun({
      ...baseInput,
      heartbeats: [
        { ok: true, timestamp: 0 },
        { ok: true, timestamp: 200_000 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('heartbeat'))).toBe(true);
  });

  it('heartbeat が一度も成功しなければ専用メッセージで FAIL する', () => {
    const result = evaluateSoakRun({
      ...baseInput,
      heartbeats: [
        { ok: false, timestamp: 0 },
        { ok: false, timestamp: 30_000 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('一度も成功'))).toBe(true);
  });
});
