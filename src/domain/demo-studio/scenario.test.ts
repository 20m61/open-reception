import { describe, expect, it } from 'vitest';
import {
  DEMO_INITIAL_MODES,
  DEMO_INPUT_MODES,
  DEMO_CALL_RESULTS,
  DEMO_QR_RESULTS,
  DEMO_STT_RESULTS,
  DEMO_RUNTIME_STATES,
  isDemoScenario,
  type DemoScenario,
} from './scenario';
import { ROUTE_RESULTS } from '@/domain/routing/policy';

function valid(): DemoScenario {
  return {
    id: 'sample',
    name: 'サンプル',
    initialMode: 'reception',
    visitorInputs: [{ mode: 'touch', value: 'meeting' }],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  };
}

describe('DemoScenario 語彙 (issue #363 本文の型定義どおり)', () => {
  it('initialMode は 5 種', () => {
    expect([...DEMO_INITIAL_MODES]).toEqual([
      'signage',
      'attract',
      'reception',
      'qr',
      'out_of_hours',
    ]);
  });

  it('入力手段は touch/voice/text/qr', () => {
    expect([...DEMO_INPUT_MODES]).toEqual(['touch', 'voice', 'text', 'qr']);
  });

  it('call 結果語彙は #374 RouteResult の部分集合（独自契約を発明しない）', () => {
    for (const r of DEMO_CALL_RESULTS) {
      expect(ROUTE_RESULTS as readonly string[]).toContain(r);
    }
    expect([...DEMO_CALL_RESULTS]).toEqual(['answered', 'declined', 'no_answer', 'failed']);
  });

  it('qr / stt / runtime 語彙', () => {
    expect([...DEMO_QR_RESULTS]).toEqual(['valid', 'expired', 'used', 'revoked']);
    expect([...DEMO_STT_RESULTS]).toEqual(['success', 'low_confidence', 'error']);
    expect([...DEMO_RUNTIME_STATES]).toEqual(['ready', 'starting', 'stopped', 'degraded']);
  });
});

describe('isDemoScenario', () => {
  it('正しい形を受理する', () => {
    expect(isDemoScenario(valid())).toBe(true);
  });

  it('simulatedResults の任意フィールドは省略できる', () => {
    expect(isDemoScenario({ ...valid(), simulatedResults: {} })).toBe(true);
  });

  it('未知の initialMode を拒否する', () => {
    expect(isDemoScenario({ ...valid(), initialMode: 'lobby' })).toBe(false);
  });

  it('未知の入力手段を拒否する', () => {
    expect(
      isDemoScenario({ ...valid(), visitorInputs: [{ mode: 'gesture', value: 'x' }] }),
    ).toBe(false);
  });

  it('未知の call 結果（accepted 等）を拒否する — RouteResult 全域ではなく規定 4 種のみ', () => {
    expect(isDemoScenario({ ...valid(), simulatedResults: { call: ['accepted'] } })).toBe(false);
  });

  it('未知の qr / runtime を拒否する', () => {
    expect(isDemoScenario({ ...valid(), simulatedResults: { qr: 'unknown' } })).toBe(false);
    expect(isDemoScenario({ ...valid(), simulatedResults: { runtime: 'crashed' } })).toBe(false);
  });

  it('id/name 欠落・非オブジェクトを拒否する', () => {
    expect(isDemoScenario(null)).toBe(false);
    expect(isDemoScenario({})).toBe(false);
    expect(isDemoScenario({ ...valid(), id: '' })).toBe(false);
    expect(isDemoScenario({ ...valid(), name: 42 })).toBe(false);
    expect(isDemoScenario({ ...valid(), visitorInputs: 'x' })).toBe(false);
  });
});
