/**
 * ManagedRuntimeService registry のテスト (issue #367 Increment 1)。
 * issue 本文「初期サービス設定」表と registry 定数がずれないことを機械で固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  MANAGED_RUNTIME_SERVICES,
  RUNTIME_CAPABILITIES,
  findManagedRuntimeService,
  type ManagedRuntimeServiceKey,
} from './registry';

/** issue #367 本文の表（サービス / 初期モード）をそのまま転記したもの。 */
const ISSUE_TABLE: ReadonlyArray<readonly [ManagedRuntimeServiceKey, string]> = [
  ['realtime-conversation', 'follow_operating_hours'],
  ['stt', 'follow_operating_hours'],
  ['dynamic-tts', 'follow_operating_hours'],
  ['bedrock', 'follow_operating_hours'],
  ['vonage-pstn', 'follow_operating_hours'],
  ['qr-resolution', 'always_on'],
  ['touch-reception', 'always_on'],
  ['signage', 'always_on'],
  ['admin', 'always_on'],
  ['monitoring', 'always_on'],
];

describe('MANAGED_RUNTIME_SERVICES', () => {
  it('issue 本文の 10 サービスを既定モードごと保持する', () => {
    expect(MANAGED_RUNTIME_SERVICES.map((s) => [s.serviceKey, s.defaultMode])).toEqual(
      ISSUE_TABLE.map((row) => [row[0], row[1]]),
    );
  });

  it('serviceKey は一意', () => {
    const keys = MANAGED_RUNTIME_SERVICES.map((s) => s.serviceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('常時稼働群（サイネージ・管理・監視・QR確認・タッチ案内）は always_on', () => {
    const alwaysOn = MANAGED_RUNTIME_SERVICES.filter((s) => s.defaultMode === 'always_on').map((s) => s.serviceKey);
    expect([...alwaysOn].sort()).toEqual(['admin', 'monitoring', 'qr-resolution', 'signage', 'touch-reception']);
  });

  it('dependsOn は既知の serviceKey のみを参照し、自己参照しない', () => {
    const keys = new Set<string>(MANAGED_RUNTIME_SERVICES.map((s) => s.serviceKey));
    for (const service of MANAGED_RUNTIME_SERVICES) {
      for (const dep of service.dependsOn) {
        expect(keys.has(dep)).toBe(true);
        expect(dep).not.toBe(service.serviceKey);
      }
    }
  });

  it('dependsOn は循環しない（依存順 start / 逆依存順 stop が定義できる）', () => {
    const byKey = new Map(MANAGED_RUNTIME_SERVICES.map((s) => [s.serviceKey, s]));
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (key: ManagedRuntimeServiceKey, trail: string[]): void => {
      if (state.get(key) === 'done') return;
      expect(state.get(key), `cycle: ${[...trail, key].join(' -> ')}`).not.toBe('visiting');
      state.set(key, 'visiting');
      for (const dep of byKey.get(key)?.dependsOn ?? []) visit(dep, [...trail, key]);
      state.set(key, 'done');
    };
    for (const service of MANAGED_RUNTIME_SERVICES) visit(service.serviceKey, []);
  });

  it('各 RuntimeCapability の提供元はちょうど 1 サービス（能力欠落の原因が一意に辿れる）', () => {
    for (const capability of RUNTIME_CAPABILITIES) {
      const providers = MANAGED_RUNTIME_SERVICES.filter((s) => s.provides.includes(capability));
      expect(providers.map((p) => p.serviceKey), capability).toHaveLength(1);
    }
  });

  it('provides は RuntimeCapability の閉じた集合に収まる', () => {
    for (const service of MANAGED_RUNTIME_SERVICES) {
      for (const capability of service.provides) {
        expect(RUNTIME_CAPABILITIES).toContain(capability);
      }
    }
  });

  it('各能力の提供元を名指しで固定する（能力欠落の帰属先が定数から生成されない）', () => {
    // 🔴 「提供元はちょうど 1 サービス」だけでは**どのサービスか**を縛れない。
    // `notify_staff` を monitoring → admin へ移す変異は、どちらも always_on で
    // 区別が付かないため全テストを素通りした（独立レビューの実測）。ここは
    // 定数から期待値を作らず、issue の表を独立に転記する。
    const EXPECTED: Record<string, readonly string[]> = {
      'realtime-conversation': [],
      stt: ['speech_input'],
      'dynamic-tts': ['dynamic_speech_output'],
      bedrock: ['ai_intent_resolution'],
      'vonage-pstn': ['live_bridge'],
      'qr-resolution': [],
      'touch-reception': [],
      signage: [],
      admin: [],
      monitoring: ['notify_staff'],
    };
    for (const [serviceKey, provides] of Object.entries(EXPECTED)) {
      expect(findManagedRuntimeService(serviceKey as never)?.provides, serviceKey).toEqual(provides);
    }
  });

  it('stt / dynamic-tts はリアルタイム会話ランタイムに依存する', () => {
    expect(findManagedRuntimeService('stt')?.dependsOn).toEqual(['realtime-conversation']);
    expect(findManagedRuntimeService('dynamic-tts')?.dependsOn).toEqual(['realtime-conversation']);
  });

  it('findManagedRuntimeService は未知キーで undefined', () => {
    expect(findManagedRuntimeService('unknown-service' as ManagedRuntimeServiceKey)).toBeUndefined();
  });
});
