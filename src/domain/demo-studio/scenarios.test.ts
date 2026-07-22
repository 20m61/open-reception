import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS, DEMO_SCENARIO_IDS, getDemoScenario } from './scenarios';
import { isDemoScenario, type DemoInitialMode } from './scenario';

describe('DEMO_SCENARIOS (issue #363 初期 9 シナリオ + #364 音声成功系)', () => {
  it('10 シナリオを seed する（初期 9 + 音声成功系 1）', () => {
    expect(DEMO_SCENARIOS).toHaveLength(10);
  });

  it('全シナリオが有効な DemoScenario で、id は一意', () => {
    for (const s of DEMO_SCENARIOS) {
      expect(isDemoScenario(s)).toBe(true);
    }
    const ids = DEMO_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEMO_SCENARIO_IDS は seed の id 列と一致', () => {
    expect(DEMO_SCENARIO_IDS).toEqual(DEMO_SCENARIOS.map((s) => s.id));
  });

  it('AC の 5 局面（通常/QR/未応答/障害/営業時間外）を最低 1 つずつ seed する', () => {
    const modes = new Set<DemoInitialMode>(DEMO_SCENARIOS.map((s) => s.initialMode));
    // 通常受付・QR・営業時間外の initialMode がそろう。
    expect(modes.has('reception')).toBe(true);
    expect(modes.has('qr')).toBe(true);
    expect(modes.has('out_of_hours')).toBe(true);
    // サイネージ→ATTRACT の入口も seed する。
    expect(modes.has('signage') || modes.has('attract')).toBe(true);

    const callResults = DEMO_SCENARIOS.flatMap((s) => s.simulatedResults.call ?? []);
    // 未応答（no_answer）と障害（failed）を含む。
    expect(callResults).toContain('no_answer');
    expect(callResults).toContain('failed');
    expect(callResults).toContain('answered');

    // QR 期限切れ・音声認識失敗も seed する。
    const qr = DEMO_SCENARIOS.map((s) => s.simulatedResults.qr);
    expect(qr).toContain('expired');
    expect(qr).toContain('valid');
    const stt = DEMO_SCENARIOS.map((s) => s.simulatedResults.stt);
    expect(stt).toContain('error');
    // 音声成功系（発話→復唱→確定→相手選択の自動再生, #364）も seed する。
    expect(stt).toContain('success');
  });

  it('未応答→代理→部門代表シナリオは複数手の call 列を持つ', () => {
    const escalation = DEMO_SCENARIOS.find((s) => (s.simulatedResults.call?.length ?? 0) >= 2);
    expect(escalation).toBeDefined();
  });

  it('getDemoScenario は id で引ける・未知 id は undefined', () => {
    const first = DEMO_SCENARIOS[0]!;
    expect(getDemoScenario(first.id)).toBe(first);
    expect(getDemoScenario('no-such-id')).toBeUndefined();
  });
});
