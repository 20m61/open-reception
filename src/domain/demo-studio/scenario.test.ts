import { describe, expect, it } from 'vitest';
import {
  DEMO_INITIAL_MODES,
  DEMO_INPUT_MODES,
  DEMO_CALL_RESULTS,
  DEMO_QR_RESULTS,
  DEMO_STT_RESULTS,
  DEMO_RUNTIME_STATES,
  DEMO_SCENARIO_LIMITS,
  hasUnsafeScenarioText,
  isDemoScenario,
  validateDemoScenario,
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

describe('hasUnsafeScenarioText (sandbox 内容境界)', () => {
  it('通常のデモ文言は安全', () => {
    expect(hasUnsafeScenarioText('担当者への通常訪問')).toBe(false);
    expect(hasUnsafeScenarioText('staff:sato')).toBe(false);
    expect(hasUnsafeScenarioText('dept-reception')).toBe(false);
  });

  it('URL・スクリプト・補間・制御文字を拒否する', () => {
    expect(hasUnsafeScenarioText('https://evil.example')).toBe(true);
    expect(hasUnsafeScenarioText('//evil.example/x')).toBe(true);
    expect(hasUnsafeScenarioText('javascript:alert(1)')).toBe(true);
    expect(hasUnsafeScenarioText('data:text/html,x')).toBe(true);
    expect(hasUnsafeScenarioText('<script>x</script>')).toBe(true);
    expect(hasUnsafeScenarioText('${process.env.SECRET}')).toBe(true);
    expect(hasUnsafeScenarioText('{{token}}')).toBe(true);
    expect(hasUnsafeScenarioText('line1\nline2')).toBe(true);
  });
});

describe('validateDemoScenario (Inc2 保存時検証・フィールド別エラー)', () => {
  it('正しいシナリオは trim 済みで受理する', () => {
    const res = validateDemoScenario({ ...valid(), name: '  サンプル  ' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.scenario.name).toBe('サンプル');
      expect(res.scenario.visitorInputs).toEqual([{ mode: 'touch', value: 'meeting' }]);
      expect(res.scenario.simulatedResults).toEqual({ call: ['answered'], runtime: 'ready' });
    }
  });

  it('未知 mode・型不正をフィールド別に集約する', () => {
    const res = validateDemoScenario({
      id: 'x',
      name: '',
      initialMode: 'lobby',
      visitorInputs: [{ mode: 'gesture', value: 'y' }],
      simulatedResults: { call: ['accepted'], runtime: 'crashed' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.name).toBeDefined();
      expect(res.errors.initialMode).toBeDefined();
      expect(res.errors['visitorInputs.0.mode']).toBeDefined();
      expect(res.errors['simulatedResults.call']).toBeDefined();
      expect(res.errors['simulatedResults.runtime']).toBeDefined();
    }
  });

  it('巨大入力（名前・値・ターン数・呼び出し数）を上限で弾く', () => {
    const big = validateDemoScenario({
      ...valid(),
      name: 'あ'.repeat(DEMO_SCENARIO_LIMITS.nameMaxLength + 1),
      visitorInputs: Array.from({ length: DEMO_SCENARIO_LIMITS.maxVisitorInputs + 1 }, () => ({
        mode: 'touch',
        value: 'x',
      })),
      simulatedResults: {
        call: Array.from({ length: DEMO_SCENARIO_LIMITS.maxCallResults + 1 }, () => 'answered'),
      },
    });
    expect(big.ok).toBe(false);
    if (!big.ok) {
      expect(big.errors.name).toBeDefined();
      expect(big.errors.visitorInputs).toBeDefined();
      expect(big.errors['simulatedResults.call']).toBeDefined();
    }

    const longValue = validateDemoScenario({
      ...valid(),
      visitorInputs: [{ mode: 'touch', value: 'x'.repeat(DEMO_SCENARIO_LIMITS.valueMaxLength + 1) }],
    });
    expect(longValue.ok).toBe(false);
    if (!longValue.ok) expect(longValue.errors['visitorInputs.0.value']).toBeDefined();
  });

  it('URL・スクリプトを含む文言は保存拒否（sandbox 内容境界）', () => {
    const res = validateDemoScenario({ ...valid(), name: 'https://evil.example' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.name).toBeDefined();

    const turn = validateDemoScenario({
      ...valid(),
      visitorInputs: [{ mode: 'text', value: '<script>alert(1)</script>' }],
    });
    expect(turn.ok).toBe(false);
    if (!turn.ok) expect(turn.errors['visitorInputs.0.value']).toBeDefined();
  });

  it('不正な id 文字種・非オブジェクトを拒否する', () => {
    const bad = validateDemoScenario({ ...valid(), id: 'has space!' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.id).toBeDefined();
    expect(validateDemoScenario(null).ok).toBe(false);
  });
});
