/**
 * resolveServiceStates のテスト (issue #367 Increment 1)。
 *
 * 優先順位チェーン（break-glass > temporary override > exception date > custom service schedule
 * > common weekly schedule > default policy）を**段ごと**に固定し、依存整合の安全側補正と
 * Capability 集約を検証する。
 */
import { describe, expect, it } from 'vitest';
import type { OperatingException, TimeRange, Weekday } from '@/domain/operating-policy/types';
import { MANAGED_RUNTIME_SERVICES, type ManagedRuntimeService, type ManagedRuntimeServiceKey } from './registry';
import {
  BREAK_GLASS_PROTECTED_SERVICES,
  resolveServiceStates,
  resolutionFor,
  type RuntimeOperatingPolicy,
  type ServicePolicyOverride,
} from './resolve';

/** Asia/Tokyo（UTC+9 固定・DST なし）の現地日時から UTC epoch ms を作る。 */
function tokyo(y: number, m: number, d: number, hh: number, mm = 0, ss = 0): number {
  return Date.UTC(y, m - 1, d, hh - 9, mm, ss);
}

const ALL_DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** 全曜日同一の週間スケジュールを作る。 */
function everyDay(...ranges: TimeRange[]): Partial<Record<Weekday, TimeRange[]>> {
  return Object.fromEntries(ALL_DAYS.map((d) => [d, ranges])) as Partial<Record<Weekday, TimeRange[]>>;
}

/** issue #367 既定の共通営業時間 8:00〜23:00。 */
const COMMON_8_23: RuntimeOperatingPolicy['commonSchedule'] = {
  timezone: 'Asia/Tokyo',
  weeklySchedule: everyDay({ start: '08:00', end: '23:00' }),
  fixedHolidays: [],
  exceptionDates: [],
};

function policyWith(services: Partial<Record<ManagedRuntimeServiceKey, ServicePolicyOverride>>): RuntimeOperatingPolicy {
  return { commonSchedule: COMMON_8_23, services };
}

/** 2026-07-22 は水曜。営業時間内 10:00 と営業時間外 02:00 を代表点に使う。 */
const IN_HOURS = tokyo(2026, 7, 22, 10);
const OUT_OF_HOURS = tokyo(2026, 7, 22, 2);

function stateOf(policy: RuntimeOperatingPolicy, key: ManagedRuntimeServiceKey, now: number) {
  const resolution = resolutionFor(resolveServiceStates({ policy, now }), key);
  expect(resolution, key).toBeDefined();
  return { state: resolution!.state, reason: resolution!.reason };
}

describe('AC1 既定モードでの解決', () => {
  it('営業時間内は 10 サービスすべて running', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect(result.services).toHaveLength(10);
    expect(result.services.every((s) => s.state === 'running')).toBe(true);
  });

  it('営業時間外でも always_on 群は running（既定ポリシー段で決まる）', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: OUT_OF_HOURS });
    for (const key of ['signage', 'admin', 'monitoring', 'qr-resolution', 'touch-reception'] as const) {
      expect(resolutionFor(result, key), key).toMatchObject({ state: 'running', reason: 'default_policy' });
    }
  });

  it('営業時間外は follow_operating_hours 群が共通営業時間段で stopped', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: OUT_OF_HOURS });
    for (const key of ['realtime-conversation', 'stt', 'dynamic-tts', 'bedrock', 'vonage-pstn'] as const) {
      expect(resolutionFor(result, key), key).toMatchObject({ state: 'stopped', reason: 'common_weekly_schedule' });
    }
  });

  it('営業時間内の follow_operating_hours 群の理由は共通営業時間段', () => {
    expect(stateOf({ commonSchedule: COMMON_8_23 }, 'stt', IN_HOURS)).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('解決結果は registry の順序を保つ', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect(result.services[0]?.serviceKey).toBe('realtime-conversation');
    expect(result.services.at(-1)?.serviceKey).toBe('monitoring');
  });

  it('実効モードを出力に含める（override があればそれが実効値）', () => {
    const result = resolveServiceStates({ policy: policyWith({ stt: { mode: 'manual_only' } }), now: IN_HOURS });
    expect(resolutionFor(result, 'stt')?.mode).toBe('manual_only');
    expect(resolutionFor(result, 'bedrock')?.mode).toBe('follow_operating_hours');
  });
});

describe('AC2 サービス個別スケジュール', () => {
  const CUSTOM_10_12: ServicePolicyOverride = { weeklySchedule: everyDay({ start: '10:00', end: '12:00' }) };

  it('共通営業時間が開いていてもサービス個別スケジュールが閉じていれば stopped', () => {
    expect(stateOf(policyWith({ bedrock: CUSTOM_10_12 }), 'bedrock', tokyo(2026, 7, 22, 9))).toEqual({
      state: 'stopped',
      reason: 'custom_service_schedule',
    });
  });

  it('サービス個別スケジュールの営業時間内は running', () => {
    expect(stateOf(policyWith({ bedrock: CUSTOM_10_12 }), 'bedrock', tokyo(2026, 7, 22, 11))).toEqual({
      state: 'running',
      reason: 'custom_service_schedule',
    });
  });

  it('共通営業時間が閉じていてもサービス個別スケジュールが開いていれば running', () => {
    const policy = policyWith({ bedrock: { weeklySchedule: everyDay({ start: '01:00', end: '03:00' }) } });
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({ state: 'running', reason: 'custom_service_schedule' });
  });

  it('個別スケジュールは指定サービスにだけ効く', () => {
    const result = resolveServiceStates({ policy: policyWith({ bedrock: CUSTOM_10_12 }), now: tokyo(2026, 7, 22, 9) });
    expect(resolutionFor(result, 'bedrock')?.state).toBe('stopped');
    expect(resolutionFor(result, 'vonage-pstn')).toMatchObject({ state: 'running', reason: 'common_weekly_schedule' });
  });

  it('空の週間スケジュール（全曜日休止）も個別スケジュール段として扱う', () => {
    expect(stateOf(policyWith({ bedrock: { weeklySchedule: {} } }), 'bedrock', IN_HOURS)).toEqual({
      state: 'stopped',
      reason: 'custom_service_schedule',
    });
  });
});

describe('AC3 優先順位 6 段', () => {
  const OPEN_EXCEPTION: OperatingException = { date: '2026-07-22', closed: false, ranges: [{ start: '09:00', end: '20:00' }] };
  const CLOSED_EXCEPTION: OperatingException = { date: '2026-07-22', closed: true };

  it('1. break-glass は temporary override に勝つ', () => {
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: COMMON_8_23,
      breakGlass: { active: true },
      services: { bedrock: { temporaryOverride: { state: 'force_running', expiresAt: new Date(tokyo(2026, 7, 22, 23)).toISOString() } } },
    };
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'stopped', reason: 'break_glass' });
  });

  it('2. temporary override は例外日に勝つ', () => {
    const policy = policyWith({
      bedrock: {
        exceptionDates: [CLOSED_EXCEPTION],
        temporaryOverride: { state: 'force_running', expiresAt: new Date(tokyo(2026, 7, 22, 12)).toISOString() },
      },
    });
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'running', reason: 'temporary_override' });
  });

  it('3. 例外日はサービス個別スケジュールに勝つ', () => {
    const policy = policyWith({
      bedrock: { weeklySchedule: everyDay({ start: '08:00', end: '20:00' }), exceptionDates: [CLOSED_EXCEPTION] },
    });
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'stopped', reason: 'exception_date' });
  });

  it('3b. 例外日の臨時営業は共通営業時間外でも running', () => {
    const policy = policyWith({
      bedrock: { exceptionDates: [{ date: '2026-07-22', closed: false, ranges: [{ start: '01:00', end: '03:00' }] }] },
    });
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({ state: 'running', reason: 'exception_date' });
  });

  it('3c. 例外日の日跨ぎ区間は翌日側にも持ち越す', () => {
    const policy = policyWith({
      bedrock: { exceptionDates: [{ date: '2026-07-22', closed: false, ranges: [{ start: '22:00', end: '02:00', crossesMidnight: true }] }] },
    });
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 23, 1))).toEqual({ state: 'running', reason: 'exception_date' });
  });

  it('3d. 対象日でない例外日は段をスキップする', () => {
    const policy = policyWith({ bedrock: { exceptionDates: [{ date: '2026-07-25', closed: true }] } });
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'running', reason: 'common_weekly_schedule' });
  });

  it('4. サービス個別スケジュールは共通営業時間に勝つ', () => {
    const policy = policyWith({ bedrock: { weeklySchedule: everyDay({ start: '01:00', end: '03:00' }) } });
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'stopped', reason: 'custom_service_schedule' });
  });

  it('5. 共通営業時間は既定ポリシーに勝つ（follow_operating_hours のとき）', () => {
    expect(stateOf({ commonSchedule: COMMON_8_23 }, 'bedrock', OUT_OF_HOURS)).toEqual({
      state: 'stopped',
      reason: 'common_weekly_schedule',
    });
    // 同じ時刻でもモードが always_on なら共通営業時間段に入らず既定ポリシー段で running。
    expect(stateOf(policyWith({ bedrock: { mode: 'always_on' } }), 'bedrock', OUT_OF_HOURS)).toEqual({
      state: 'running',
      reason: 'default_policy',
    });
  });

  it('5b. 共通営業時間の休業日（例外日）も follow 群へ波及する', () => {
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: { ...COMMON_8_23, exceptionDates: [CLOSED_EXCEPTION] },
    };
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'stopped', reason: 'common_weekly_schedule' });
    expect(stateOf(policy, 'signage', IN_HOURS)).toEqual({ state: 'running', reason: 'default_policy' });
  });

  it('6. 既定ポリシー: manual_only は営業時間内でも stopped', () => {
    expect(stateOf(policyWith({ bedrock: { mode: 'manual_only' } }), 'bedrock', IN_HOURS)).toEqual({
      state: 'stopped',
      reason: 'default_policy',
    });
  });

  it('6b. 既定ポリシー: custom_schedule でスケジュール未設定なら stopped（安全側）', () => {
    expect(stateOf(policyWith({ bedrock: { mode: 'custom_schedule' } }), 'bedrock', IN_HOURS)).toEqual({
      state: 'stopped',
      reason: 'default_policy',
    });
  });

  it('open な例外日は共通営業時間段を飛ばして running を決める', () => {
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: { ...COMMON_8_23, exceptionDates: [CLOSED_EXCEPTION] },
      services: { bedrock: { exceptionDates: [OPEN_EXCEPTION] } },
    };
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'running', reason: 'exception_date' });
  });
});

describe('AC4 temporaryOverride の期限', () => {
  const overrideExpiring = (expiresAtMs: number): RuntimeOperatingPolicy =>
    policyWith({
      bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: new Date(expiresAtMs).toISOString() } },
    });

  it('期限前は適用される', () => {
    expect(stateOf(overrideExpiring(IN_HOURS + 60_000), 'bedrock', IN_HOURS)).toEqual({
      state: 'stopped',
      reason: 'temporary_override',
    });
  });

  it('expiresAt === now は無効（<= now で自動解除）', () => {
    expect(stateOf(overrideExpiring(IN_HOURS), 'bedrock', IN_HOURS)).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('期限経過後は無視され次段へ落ちる', () => {
    expect(stateOf(overrideExpiring(IN_HOURS - 1), 'bedrock', IN_HOURS)).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('force_running の override も期限後は無視される', () => {
    const policy = policyWith({
      bedrock: { temporaryOverride: { state: 'force_running', expiresAt: new Date(OUT_OF_HOURS - 1).toISOString() } },
    });
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({ state: 'stopped', reason: 'common_weekly_schedule' });
  });

  it('解析不能な expiresAt は無視する（期限不明の override を効かせない）', () => {
    const policy = policyWith({ bedrock: { temporaryOverride: { state: 'force_running', expiresAt: 'not-a-date' } } });
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({ state: 'stopped', reason: 'common_weekly_schedule' });
  });

  it('draining の override は期限内なら draining', () => {
    const policy = policyWith({
      bedrock: { temporaryOverride: { state: 'draining', expiresAt: new Date(IN_HOURS + 60_000).toISOString() } },
    });
    expect(stateOf(policy, 'bedrock', IN_HOURS)).toEqual({ state: 'draining', reason: 'temporary_override' });
  });
});

describe('AC5 依存整合の安全側補正', () => {
  const forceRunningStt = (expiresAtMs: number): RuntimeOperatingPolicy =>
    policyWith({ stt: { temporaryOverride: { state: 'force_running', expiresAt: new Date(expiresAtMs).toISOString() } } });

  it('依存先 stopped のまま依存元を running にはしない', () => {
    const result = resolveServiceStates({ policy: forceRunningStt(OUT_OF_HOURS + 3_600_000), now: OUT_OF_HOURS });
    expect(resolutionFor(result, 'stt')).toMatchObject({
      state: 'stopped',
      reason: 'dependency_correction',
      correction: { blockedBy: 'realtime-conversation', from: { state: 'running', reason: 'temporary_override' } },
    });
  });

  it('依存先 draining なら依存元も draining へ補正する', () => {
    const policy = policyWith({
      'realtime-conversation': { temporaryOverride: { state: 'draining', expiresAt: new Date(IN_HOURS + 60_000).toISOString() } },
    });
    expect(stateOf(policy, 'stt', IN_HOURS)).toEqual({ state: 'draining', reason: 'dependency_correction' });
  });

  it('依存先が running なら補正しない（理由は元の段のまま）', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect(resolutionFor(result, 'stt')?.reason).toBe('common_weekly_schedule');
    expect(resolutionFor(result, 'stt')?.correction).toBeUndefined();
  });

  it('依存元が既に stopped なら補正扱いにしない', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: OUT_OF_HOURS });
    expect(resolutionFor(result, 'stt')?.reason).toBe('common_weekly_schedule');
    expect(resolutionFor(result, 'stt')?.correction).toBeUndefined();
  });

  it('推移的な依存も補正される', () => {
    const chain: ManagedRuntimeService[] = [
      { serviceKey: 'a' as ManagedRuntimeServiceKey, defaultMode: 'manual_only', dependsOn: [], provides: [] },
      { serviceKey: 'b' as ManagedRuntimeServiceKey, defaultMode: 'always_on', dependsOn: ['a' as ManagedRuntimeServiceKey], provides: [] },
      { serviceKey: 'c' as ManagedRuntimeServiceKey, defaultMode: 'always_on', dependsOn: ['b' as ManagedRuntimeServiceKey], provides: ['speech_input'] },
    ];
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, services: chain, now: IN_HOURS });
    expect(resolutionFor(result, 'c' as ManagedRuntimeServiceKey)).toMatchObject({
      state: 'stopped',
      reason: 'dependency_correction',
      correction: { blockedBy: 'b' },
    });
    expect(result.capabilities).toEqual([]);
  });

  it('未知の依存先は補正対象にしない（registry に無い依存は無視）', () => {
    const services: ManagedRuntimeService[] = [
      { serviceKey: 'solo' as ManagedRuntimeServiceKey, defaultMode: 'always_on', dependsOn: ['ghost' as ManagedRuntimeServiceKey], provides: [] },
    ];
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, services, now: IN_HOURS });
    expect(resolutionFor(result, 'solo' as ManagedRuntimeServiceKey)).toMatchObject({ state: 'running', reason: 'default_policy' });
  });
});

describe('AC6 Capability 集約', () => {
  it('営業時間内は全 Capability が揃う', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect([...result.capabilities].sort()).toEqual([
      'ai_intent_resolution',
      'dynamic_speech_output',
      'live_bridge',
      'notify_staff',
      'speech_input',
    ]);
  });

  it('STT だけ停止すると speech_input だけが落ちる', () => {
    const policy = policyWith({
      stt: { temporaryOverride: { state: 'force_stopped', expiresAt: new Date(IN_HOURS + 60_000).toISOString() } },
    });
    const result = resolveServiceStates({ policy, now: IN_HOURS });
    expect(result.capabilities).not.toContain('speech_input');
    expect([...result.capabilities].sort()).toEqual([
      'ai_intent_resolution',
      'dynamic_speech_output',
      'live_bridge',
      'notify_staff',
    ]);
  });

  it('営業時間外は notify_staff（常時稼働の監視・通知）だけが残る', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: OUT_OF_HOURS });
    expect(result.capabilities).toEqual(['notify_staff']);
  });

  it('draining 中のサービスは Capability を提供しない（新規受付を増やさない）', () => {
    const policy = policyWith({
      stt: { temporaryOverride: { state: 'draining', expiresAt: new Date(IN_HOURS + 60_000).toISOString() } },
    });
    const result = resolveServiceStates({ policy, now: IN_HOURS });
    expect(result.capabilities).not.toContain('speech_input');
  });

  it('Capability は重複しない', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect(new Set(result.capabilities).size).toBe(result.capabilities.length);
  });
});

describe('break-glass', () => {
  it('保護対象は管理面と監視の 2 つ（解除手段と可観測性を残す）', () => {
    // 定数から期待値を作らない（保護対象の増減そのものを検出させる）。
    expect([...BREAK_GLASS_PROTECTED_SERVICES]).toEqual(['admin', 'monitoring']);
  });

  it('serviceKeys 省略時は管理面（admin / monitoring）以外を停止する', () => {
    const result = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23, breakGlass: { active: true } },
      now: IN_HOURS,
    });
    const protectedKeys: readonly string[] = ['admin', 'monitoring'];
    for (const service of result.services) {
      if (protectedKeys.includes(service.serviceKey)) {
        expect(service, service.serviceKey).toMatchObject({ state: 'running', reason: 'default_policy' });
      } else {
        expect(service, service.serviceKey).toMatchObject({ state: 'stopped', reason: 'break_glass' });
      }
    }
    expect(result.capabilities).toEqual(['notify_staff']);
  });

  it('serviceKeys を指定すればそのサービスだけ停止する', () => {
    const result = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23, breakGlass: { active: true, serviceKeys: ['vonage-pstn'] } },
      now: IN_HOURS,
    });
    expect(resolutionFor(result, 'vonage-pstn')).toMatchObject({ state: 'stopped', reason: 'break_glass' });
    expect(resolutionFor(result, 'stt')?.state).toBe('running');
    expect(result.capabilities).not.toContain('live_bridge');
  });

  it('active:false の break-glass は効かない', () => {
    const result = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23, breakGlass: { active: false } },
      now: IN_HOURS,
    });
    expect(result.services.every((s) => s.state === 'running')).toBe(true);
  });

  it('break-glass は保護対象を明示指定すれば停止できる（運用者の明示操作は妨げない）', () => {
    const result = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23, breakGlass: { active: true, serviceKeys: ['monitoring'] } },
      now: IN_HOURS,
    });
    expect(resolutionFor(result, 'monitoring')).toMatchObject({ state: 'stopped', reason: 'break_glass' });
  });
});

describe('入力の頑健性', () => {
  it('registry に無い serviceKey の override は無視する', () => {
    const policy = policyWith({ ['ghost' as ManagedRuntimeServiceKey]: { mode: 'manual_only' } });
    const result = resolveServiceStates({ policy, now: IN_HOURS });
    expect(result.services).toHaveLength(10);
    expect(resolutionFor(result, 'ghost' as ManagedRuntimeServiceKey)).toBeUndefined();
  });

  it('timezone 未指定の共通スケジュールは既定 TZ で評価する', () => {
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: { ...COMMON_8_23, timezone: '' },
    };
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({ state: 'stopped', reason: 'common_weekly_schedule' });
  });

  it('resolutionFor は未知キーで undefined', () => {
    const result = resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS });
    expect(resolutionFor(result, 'nope' as ManagedRuntimeServiceKey)).toBeUndefined();
  });
});

describe('独立レビューで見つかった欠陥の回帰固定 (PR #791)', () => {
  const CROSS_MIDNIGHT: ServicePolicyOverride = {
    exceptionDates: [
      { date: '2026-07-22', closed: false, ranges: [{ start: '22:00', end: '02:00', crossesMidnight: true }] },
    ],
  };

  it('日跨ぎ例外日の持ち越しは、持ち越し区間の中だけに効く', () => {
    const policy = policyWith({ 'realtime-conversation': CROSS_MIDNIGHT });
    // 持ち越し区間の中（7/23 01:00）は例外日の段で running。
    expect(stateOf(policy, 'realtime-conversation', tokyo(2026, 7, 23, 1))).toEqual({
      state: 'running',
      reason: 'exception_date',
    });
    // 🔴 持ち越し区間を抜けたら例外日の段から降りる。ここが「前日に日跨ぎ区間が存在するか」
    // だけの判定だと、翌日は終日 exception_date で stopped になり、音声受付が営業時間内に
    // 丸 1 日死ぬ（しかも reason は正当に見える値で返る）。
    expect(stateOf(policy, 'realtime-conversation', tokyo(2026, 7, 23, 10))).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
    expect(stateOf(policy, 'realtime-conversation', tokyo(2026, 7, 23, 20))).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('持ち越しは日跨ぎ区間のときだけ。当日で閉じる例外日は翌日に効かない', () => {
    const policy = policyWith({
      'realtime-conversation': {
        exceptionDates: [
          { date: '2026-07-22', closed: false, ranges: [{ start: '10:00', end: '12:00' }] },
        ],
      },
    });
    // 7/23 01:00 は共通営業時間(8:00-23:00)の外なので stopped だが、**理由が違う**。
    // 例外日の段に落ちていないことが要点。
    expect(stateOf(policy, 'realtime-conversation', tokyo(2026, 7, 23, 1))).toEqual({
      state: 'stopped',
      reason: 'common_weekly_schedule',
    });
  });

  it('break-glass の serviceKeys が空配列でも「対象なし」にしない', () => {
    // 緊急停止は誤発火より**不発**のほうが害が大きい。フォームで 1 件も選ばずに送られた
    // `[]` を no-op にすると、UI は「停止しました」と出すのに全サービスが動き続ける。
    const resolved = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23, breakGlass: { active: true, serviceKeys: [] } },
      now: IN_HOURS,
    });
    expect(resolutionFor(resolved, 'realtime-conversation')).toMatchObject({
      state: 'stopped',
      reason: 'break_glass',
    });
    // 保護対象は止めない（省略時と同じ扱い）。
    expect(resolutionFor(resolved, 'admin')).toMatchObject({ state: 'running' });
  });

  it('expiresAt はホストの TZ ではなくポリシーの TZ で解釈する', () => {
    // 🔴 `Date.parse` はオフセット無しの日時をホストのローカル時刻として読む。
    // vitest は TZ=UTC 固定なので、この違いはここで初めて見える。
    const policy = policyWith({
      bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-22T12:00' } },
    });
    // JST 11:00（= UTC 02:00）はまだ期限内。
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 11))).toEqual({
      state: 'stopped',
      reason: 'temporary_override',
    });
    // JST 13:00 は期限切れ。UTC 解釈だと 21:00 JST まで生き残ってしまう。
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 13))).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('オフセット付きの expiresAt はそのまま絶対時刻として読む', () => {
    const policy = policyWith({
      bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-22T12:00:00Z' } },
    });
    // UTC 12:00 = JST 21:00。JST 20:00 はまだ期限内。
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 20))).toMatchObject({
      reason: 'temporary_override',
    });
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 22))).toMatchObject({
      reason: 'common_weekly_schedule',
    });
  });
});

describe('レビューが素通りを実測した分岐の固定 (PR #791)', () => {
  it('推移的な依存の補正は services の並び順に依存しない（依存元が先でも収束する）', () => {
    // 補正は事前解決済みの配列に対して行うので、**深さ 1 の依存は順序に関わらず 1 パスで
    // 収束する**。既存の推移テストは依存先が先に並ぶ registry 順なので、1 パスに制限しても
    // 通ってしまい、複数パス回している意味が固定されていなかった（独立レビューの実測）。
    // 依存元が先に来る順序なら、c の補正は b の補正が済んだ次のパスでしか起きない。
    const key = (k: string) => k as ManagedRuntimeServiceKey;
    const reversedChain: ManagedRuntimeService[] = [
      { serviceKey: key('c'), defaultMode: 'always_on', dependsOn: [key('b')], provides: [] },
      { serviceKey: key('b'), defaultMode: 'always_on', dependsOn: [key('a')], provides: [] },
      { serviceKey: key('a'), defaultMode: 'manual_only', dependsOn: [], provides: [] },
    ];
    const result = resolveServiceStates({
      policy: { commonSchedule: COMMON_8_23 },
      services: reversedChain,
      now: IN_HOURS,
    });
    expect(resolutionFor(result, key('b'))).toMatchObject({
      state: 'stopped',
      reason: 'dependency_correction',
      correction: { blockedBy: 'a' },
    });
    expect(resolutionFor(result, key('c'))).toMatchObject({
      state: 'stopped',
      reason: 'dependency_correction',
      correction: { blockedBy: 'b' },
    });
  });
});

describe('mode と段の関係 (#367 / PR #791 レビュー M1)', () => {
  const CLOSED_TODAY: ServicePolicyOverride['exceptionDates'] = [{ date: '2026-07-22', closed: true }];
  const ALWAYS_OPEN = everyDay({ start: '00:00', end: '23:59' });

  it('always_on は古い例外日で止まらない（管理コンソールの自己ロックアウトを作らない）', () => {
    const policy = policyWith({ admin: { mode: 'always_on', exceptionDates: CLOSED_TODAY } });
    expect(stateOf(policy, 'admin', IN_HOURS)).toEqual({ state: 'running', reason: 'default_policy' });
  });

  it('always_on は古い個別スケジュールでも止まらない', () => {
    const policy = policyWith({
      signage: { mode: 'always_on', weeklySchedule: everyDay({ start: '08:00', end: '09:00' }) },
    });
    expect(stateOf(policy, 'signage', IN_HOURS)).toEqual({ state: 'running', reason: 'default_policy' });
  });

  it('manual_only は残ったスケジュールで勝手に起動しない（EC2 の実費を生まない）', () => {
    const policy = policyWith({ 'realtime-conversation': { mode: 'manual_only', weeklySchedule: ALWAYS_OPEN } });
    expect(stateOf(policy, 'realtime-conversation', IN_HOURS)).toEqual({
      state: 'stopped',
      reason: 'default_policy',
    });
  });

  it('follow_operating_hours では例外日・個別スケジュールが効く', () => {
    expect(
      stateOf(policyWith({ bedrock: { mode: 'follow_operating_hours', exceptionDates: CLOSED_TODAY } }), 'bedrock', IN_HOURS),
    ).toEqual({ state: 'stopped', reason: 'exception_date' });
    expect(
      stateOf(
        policyWith({ bedrock: { mode: 'follow_operating_hours', weeklySchedule: everyDay({ start: '20:00', end: '22:00' }) } }),
        'bedrock',
        IN_HOURS,
      ),
    ).toEqual({ state: 'stopped', reason: 'custom_service_schedule' });
  });

  it('custom_schedule では個別スケジュールが効く', () => {
    const policy = policyWith({ bedrock: { mode: 'custom_schedule', weeklySchedule: ALWAYS_OPEN } });
    expect(stateOf(policy, 'bedrock', OUT_OF_HOURS)).toEqual({
      state: 'running',
      reason: 'custom_service_schedule',
    });
  });

  it('always_on を止めたいときは break-glass か temporaryOverride（上位の段）が効く', () => {
    const policy = policyWith({
      admin: {
        mode: 'always_on',
        exceptionDates: CLOSED_TODAY,
        temporaryOverride: { state: 'force_stopped', expiresAt: '2099-01-01T00:00:00Z' },
      },
    });
    expect(stateOf(policy, 'admin', IN_HOURS)).toEqual({ state: 'stopped', reason: 'temporary_override' });
  });
});

describe('expiresAt の解析（外部レビュー指摘の回帰固定, PR #791）', () => {
  const at = (expiresAt: string) =>
    policyWith({ bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt } } });

  it('秒まで解釈する（切り捨てると最大 59 秒早く失効する）', () => {
    const policy = at('2026-07-22T12:00:59');
    // 12:00:30 はまだ期限内。秒を落とすと 12:00:00 で失効扱いになり、ここが落ちる。
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 30))).toEqual({
      state: 'stopped',
      reason: 'temporary_override',
    });
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 1, 0))).toEqual({
      state: 'running',
      reason: 'common_weekly_schedule',
    });
  });

  it('末尾に余計なものが付いた値は解析不能として扱う（前方一致で通さない）', () => {
    // `2026-07-22T12:00oops` を「12:00 まで」と読むのは、doc が言う
    // 「解析不能は undefined = 自動解除」と食い違う。黙って別の値として解釈しない。
    for (const bad of ['2026-07-22T12:00oops', '2026-07-22T12:00:99', '2026-07-22extra', 'not-a-date']) {
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual({
        state: 'running',
        reason: 'common_weekly_schedule',
      });
    }
  });

  it('暦として存在しない日時は解析不能として扱う（黙って先の時刻へ繰り上げない）', () => {
    /*
     * 🔴 `Date` も `zonedTimeToUtcMs` も `2026-13-45` を 2027 年へ、`99:99` を翌日以降へ
     * 繰り上げる。`force_stopped` と組み合わさると、月や時刻の 1 桁ミスが**数か月の
     * サービス停止**になり、画面上は「その日時まで」と読めるので気づけない。
     */
    // `0000-01-01` は `Date.UTC` が 1900-01-01 へ写す（0〜99 年の特例）。年の比較を落とすと通る。
    for (const bad of ['2026-13-01', '2026-02-30', '2026-00-10', '2026-07-32', '2026-07-22T24:00', '2026-07-22T12:60', '0000-01-01']) {
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual({
        state: 'running',
        reason: 'common_weekly_schedule',
      });
    }
  });

  it('うるう年の 2/29 は年によって受理と拒否が分かれる', () => {
    // 「暦の妥当性」を月ごとの固定表で誤魔化していないことを固定する。
    expect(stateOf(at('2028-02-29'), 'bedrock', IN_HOURS)).toMatchObject({ reason: 'temporary_override' });
    expect(stateOf(at('2027-02-29'), 'bedrock', IN_HOURS)).toMatchObject({ reason: 'common_weekly_schedule' });
  });

  it('運用画面が普通に作る形を拒否しない（ミリ秒・前後空白・小文字 z）', () => {
    /*
     * `.000Z` は通るのに `.500`（オフセット無しのミリ秒つき）は通らない、という説明できない
     * 境界を残さない。`<input type="datetime-local" step="0.001">` や
     * Luxon の `toISO({ includeOffset: false })` がこの形を出す。
     */
    for (const good of ['2026-07-22T13:00:00.500', '2026-07-22T13:00:00.5', ' 2026-07-22T13:00 ', '2026-07-22T04:00:00z']) {
      expect(stateOf(at(good), 'bedrock', IN_HOURS), `expiresAt=${good}`).toMatchObject({
        reason: 'temporary_override',
      });
    }
  });

  it('ミリ秒は切り捨てず、期限の判定に効かせる', () => {
    // `.5` は 500ms（右ゼロ埋め）。`Number('5')` と読むと 5ms になり、`.5` と `.005` が同じになる。
    for (const expiresAt of ['2026-07-22T12:00:00.500', '2026-07-22T12:00:00.5']) {
      const policy = at(expiresAt);
      expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 0) + 250), expiresAt).toMatchObject({
        reason: 'temporary_override',
      });
      expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 0) + 750), expiresAt).toMatchObject({
        reason: 'common_weekly_schedule',
      });
    }
  });

  it('秒を省いた値・日付だけの値は従来どおり解釈できる', () => {
    expect(stateOf(at('2026-07-22T13:00'), 'bedrock', IN_HOURS)).toMatchObject({
      reason: 'temporary_override',
    });
    expect(stateOf(at('2026-07-23'), 'bedrock', IN_HOURS)).toMatchObject({
      reason: 'temporary_override',
    });
  });
});
