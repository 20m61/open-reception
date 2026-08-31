/**
 * resolveServiceStates のテスト (issue #367 Increment 1)。
 *
 * 優先順位チェーン（break-glass > temporary override > exception date > custom service schedule
 * > common weekly schedule > default policy）を**段ごと**に固定し、依存整合の安全側補正と
 * Capability 集約を検証する。
 */
import { describe, expect, it } from 'vitest';
import type { OperatingException, TimeRange, Weekday } from '@/domain/operating-policy/types';
import type { ManagedRuntimeService, ManagedRuntimeServiceKey } from './registry';
import {
  BREAK_GLASS_PROTECTED_SERVICES,
  expiresAtMs,
  resolveServiceStates,
  resolutionFor,
  type BreakGlassDirective,
  type RuntimeOperatingPolicy,
  type ServicePolicyOverride,
  type ServiceRuntimeState,
  type TemporaryOverride,
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

  /**
   * #798 AC4: 「全停止」を暗黙表現から明示フラグへ。
   *
   * 🔴 **意味は変えない。表現を足すだけ。** `serviceKeys` の省略／空配列が
   * 「保護対象以外を全停止」を意味する暗黙表現は、`serviceKeys` を渡し損ねると
   * 1 サービスのつもりが `touch-reception` / `qr-resolution` / `signage` まで止まり
   * **iPad がタッチ受付も QR も含めて全滅**する。「誤発火より不発が害」という設計判断
   * 自体は妥当なので、**倒し方はそのまま**に、書き手が意図を言える語彙を足す。
   */
  describe('break-glass の scope（#798 AC4）', () => {
    // 🔴 `as const` にしない。**共用体になると `serviceKeys` を持たない形が混ざり**、
    // 下の総当たりで型が通らなくなる（実際に typecheck で落ちた。vitest は型を見ない）。
    const ALL_SHAPES: readonly { label: string; directive: BreakGlassDirective }[] = [
      { label: 'active のみ', directive: { active: true } },
      { label: 'serviceKeys 省略', directive: { active: true, serviceKeys: undefined } },
      { label: 'serviceKeys 空配列', directive: { active: true, serviceKeys: [] } },
      { label: 'serviceKeys 指定', directive: { active: true, serviceKeys: ['vonage-pstn'] } },
      { label: 'active:false', directive: { active: false } },
      { label: 'active:false + keys', directive: { active: false, serviceKeys: ['vonage-pstn'] } },
    ];

    /**
     * 🔴 **これが本体の不変条件。** `scope` を足したことで、**既存の形の意味が 1 つも
     * 変わっていない**ことを総当たりで縛る。分岐ごとの期待値を手で書くと、実装と同じ
     * 誤りを共有する（CLAUDE.md「検証の作法」）ので、**旧実装と同じ結果になること**を
     * 全サービス × 全形で比較する。
     */
    it('scope を書かない既存の形は、意味が 1 つも変わらない', () => {
      for (const { label, directive } of ALL_SHAPES) {
        const resolved = resolveServiceStates({
          policy: { commonSchedule: COMMON_8_23, breakGlass: directive },
          now: IN_HOURS,
        });
        // 期待値は「旧仕様の定義」から導く: active かつ（keys が非空ならその集合／
        // それ以外は保護対象以外の全部）。
        const stopped = new Set<string>();
        if (directive.active) {
          const keys = directive.serviceKeys;
          if (keys && keys.length > 0) for (const k of keys) stopped.add(k);
          else
            for (const s of resolved.services)
              if (!BREAK_GLASS_PROTECTED_SERVICES.includes(s.serviceKey)) stopped.add(s.serviceKey);
        }
        for (const service of resolved.services) {
          const expected = stopped.has(service.serviceKey);
          expect(
            service.reason === 'break_glass',
            `${label} / ${service.serviceKey}`,
          ).toBe(expected);
        }
      }
    });

    it("scope:'all' は serviceKeys の有無によらず保護対象以外を全停止する", () => {
      // 🔴 **`serviceKeys` を無視するのが要点。** 「1 件だけ選んだつもりで全停止」を
      // 事故ではなく**宣言**にするための語彙なので、両方書かれたら scope が勝つ。
      const resolved = resolveServiceStates({
        policy: {
          commonSchedule: COMMON_8_23,
          breakGlass: { active: true, scope: 'all', serviceKeys: ['vonage-pstn'] },
        },
        now: IN_HOURS,
      });
      expect(resolutionFor(resolved, 'realtime-conversation')).toMatchObject({ reason: 'break_glass' });
      expect(resolutionFor(resolved, 'vonage-pstn')).toMatchObject({ reason: 'break_glass' });
      expect(resolutionFor(resolved, 'admin')).toMatchObject({ state: 'running' });
    });

    it("scope:'selected' は挙げたものだけを止める", () => {
      const resolved = resolveServiceStates({
        policy: {
          commonSchedule: COMMON_8_23,
          breakGlass: { active: true, scope: 'selected', serviceKeys: ['vonage-pstn'] },
        },
        now: IN_HOURS,
      });
      expect(resolutionFor(resolved, 'vonage-pstn')).toMatchObject({ reason: 'break_glass' });
      expect(resolutionFor(resolved, 'realtime-conversation')?.reason).not.toBe('break_glass');
    });

    /**
     * 🔴 **`selected` なのに空でも「対象なし」にしない。** ここを no-op にすると
     * 「誤発火より不発が害」を破る ―― UI は「停止しました」と出すのに全サービスが動き続ける。
     * 表現を明示化しても**倒し方は変えない**（それが AC4 の「意味を変えずに」である）。
     */
    it("scope:'selected' で空配列でも、不発にはせず全停止へ倒す", () => {
      const resolved = resolveServiceStates({
        policy: {
          commonSchedule: COMMON_8_23,
          breakGlass: { active: true, scope: 'selected', serviceKeys: [] },
        },
        now: IN_HOURS,
      });
      expect(resolutionFor(resolved, 'realtime-conversation')).toMatchObject({ reason: 'break_glass' });
      expect(resolutionFor(resolved, 'admin')).toMatchObject({ state: 'running' });
    });

    it("active:false なら scope:'all' でも何も止めない", () => {
      const resolved = resolveServiceStates({
        policy: { commonSchedule: COMMON_8_23, breakGlass: { active: false, scope: 'all' } },
        now: IN_HOURS,
      });
      for (const service of resolved.services) expect(service.reason).not.toBe('break_glass');
    });
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

describe('expiresAt はポリシーの timezone で解釈する（環境差でしか露見しない型）', () => {
  /*
   * 🔴 `expiresAtMs` の 🔴 コメントが名指しする失敗（Lambda(UTC) と開発機(JST) の環境差）は、
   * 既存テストが全部 `Asia/Tokyo`（= `DEFAULT_TIMEZONE`）の fixture なので**どこにも縛られて
   * いなかった**。永続層の「判定不能の切り分け」はこの前提の上に組まれているので、ここで固定する。
   */
  it('同じ現地時刻の期限が、ポリシーの timezone で有効/失効に分かれる', () => {
    const policy = (timezone: string): RuntimeOperatingPolicy => ({
      commonSchedule: {
        timezone,
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
        fixedHolidays: [],
        exceptionDates: [],
      },
      services: { bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T05:00' } } },
    });
    const now = Date.parse('2026-07-20T01:00:00Z');
    // UTC-12 では 17:00Z（未来＝有効）、UTC+14 では前日 15:00Z（過去＝失効）。
    expect(stateOf(policy('Etc/GMT+12'), 'bedrock', now)).toMatchObject({ reason: 'temporary_override' });
    expect(stateOf(policy('Etc/GMT-14'), 'bedrock', now)).not.toMatchObject({ reason: 'temporary_override' });
  });
});

describe('expiresAt の解析（外部レビュー指摘の回帰固定, PR #791）', () => {
  /*
   * 🔴 **`force_running` で見る。** #798 AC2 以降、解析不能な `force_stopped` / `draining` は
   * **維持される**ので、`force_stopped` のままだと「解析できた」と「解析不能」がどちらも
   * `stopped / temporary_override` に落ち、この describe 全体が**空虚に通る**ようになる。
   * 併せて `manual_only`（＝下位の段は `stopped / default_policy` に固定）にしておくと、
   * 「適用」と「解除」が state と reason の両方で分かれ、評価時刻にも依らない。
   */
  const at = (expiresAt: string) =>
    policyWith({ bedrock: { mode: 'manual_only', temporaryOverride: { state: 'force_running', expiresAt } } });
  /** 期限内として適用された形。 */
  const APPLIED = { state: 'running', reason: 'temporary_override' } as const;
  /** 解析不能（または期限切れ）で自動解除され、下位の段へ落ちた形。 */
  const RELEASED = { state: 'stopped', reason: 'default_policy' } as const;

  it('秒まで解釈する（切り捨てると最大 59 秒早く失効する）', () => {
    const policy = at('2026-07-22T12:00:59');
    // 12:00:30 はまだ期限内。秒を落とすと 12:00:00 で失効扱いになり、ここが落ちる。
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 30))).toEqual(APPLIED);
    expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 1, 0))).toEqual(RELEASED);
  });

  it('末尾に余計なものが付いた値は解析不能として扱う（前方一致で通さない）', () => {
    // `2026-07-22T12:00oops` を「12:00 まで」と読むのは、doc が言う
    // 「解析不能は undefined = 自動解除」と食い違う。黙って別の値として解釈しない。
    for (const bad of ['2026-07-22T12:00oops', '2026-07-22T12:00:99', '2026-07-22extra', 'not-a-date']) {
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual(RELEASED);
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
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual(RELEASED);
    }
  });

  it('うるう年の 2/29 は年によって受理と拒否が分かれる', () => {
    // 「暦の妥当性」を月ごとの固定表で誤魔化していないことを固定する。
    expect(stateOf(at('2028-02-29'), 'bedrock', IN_HOURS)).toEqual(APPLIED);
    expect(stateOf(at('2027-02-29'), 'bedrock', IN_HOURS)).toEqual(RELEASED);
  });

  it('運用画面が普通に作る形を拒否しない（ミリ秒・前後空白・小文字 z）', () => {
    /*
     * `.000Z` は通るのに `.500`（オフセット無しのミリ秒つき）は通らない、という説明できない
     * 境界を残さない。`<input type="datetime-local" step="0.001">` や
     * Luxon の `toISO({ includeOffset: false })` がこの形を出す。
     */
    for (const good of ['2026-07-22T13:00:00.500', '2026-07-22T13:00:00.5', ' 2026-07-22T13:00 ', '2026-07-22T04:00:00z']) {
      expect(stateOf(at(good), 'bedrock', IN_HOURS), `expiresAt=${good}`).toEqual(APPLIED);
    }
  });

  it('ミリ秒は切り捨てず、期限の判定に効かせる', () => {
    // `.5` は 500ms（右ゼロ埋め）。`Number('5')` と読むと 5ms になり、`.5` と `.005` が同じになる。
    for (const expiresAt of ['2026-07-22T12:00:00.500', '2026-07-22T12:00:00.5']) {
      const policy = at(expiresAt);
      expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 0) + 250), expiresAt).toEqual(APPLIED);
      expect(stateOf(policy, 'bedrock', tokyo(2026, 7, 22, 12, 0, 0) + 750), expiresAt).toEqual(RELEASED);
    }
  });

  it('文字列でない expiresAt で解決を落とさない（総関数のままにする）', () => {
    /*
     * 🔴 `expiresAt.trim()` は非文字列で throw する。Reconciler は 1 分ごとに走るので、
     * 1 レコードの型ドリフト（旧データ・部分書き込み・DynamoDB の属性型違い）で
     * **全サービスの解決が丸ごと落ち、何も収束しないまま繰り返す**。解析不能として扱う。
     */
    for (const bad of [null, undefined, 123, {}, []]) {
      const policy = at(bad as unknown as string);
      expect(() => stateOf(policy, 'bedrock', IN_HOURS), String(bad)).not.toThrow();
      expect(stateOf(policy, 'bedrock', IN_HOURS), String(bad)).toEqual(RELEASED);
    }
  });

  it('オフセット付きでも暦チェックを迂回させない', () => {
    // `Date.parse` は月の桁溢れは拒むが**日の桁溢れは通す**（`2026-02-30T00:00:00Z` → 3/2）。
    // 月末を機械生成する UI のオフバイワンで、停止が最大 3 日延びる。
    // 🔴 未来日で試す。過去日だと「期限切れで自動解除」と区別が付かず、テストが素通しになる。
    for (const bad of ['2027-02-30T00:00:00Z', '2027-06-31T00:00:00Z', '2027-02-30T00:00:00+09:00']) {
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual(RELEASED);
    }
  });

  it('ミリ秒は 3 桁まで（桁を緩めると padEnd が効かず大幅な延長になる）', () => {
    // `.123456789` を許すと `padEnd` が無効化され +123456789ms ≒ 34 時間の停止延長になる。
    expect(stateOf(at('2026-07-22T13:00:00.1234'), 'bedrock', IN_HOURS)).toEqual(RELEASED);
  });

  it('不正な timezone で解決を落とさない（expiresAt だけ塞いでも意味がない）', () => {
    // `timezone` は `expiresAt` と同じレコード・同じドリフト要因で来る。`zonedTimeToUtcMs` は
    // 不正な IANA 名で RangeError を投げるので、ここも解析不能（= 自動解除）へ倒す。
    expect(() => expiresAtMs('2026-07-22T12:00', 'Asia/Tokyoo')).not.toThrow();
    expect(expiresAtMs('2026-07-22T12:00', 'Asia/Tokyoo')).toBeNaN();
  });

  it('時刻の妥当性も経路によらず見る（Z を付けたら通る、をなくす）', () => {
    // `'2026-07-22T24:00'` は NaN なのに `'2026-07-22T24:00:00Z'` は 7/23 として通っていた。
    for (const bad of ['2027-07-22T24:00:00Z', '2027-07-22T12:60:00Z', '2027-07-22T12:00:60Z']) {
      expect(stateOf(at(bad), 'bedrock', IN_HOURS), `expiresAt=${bad}`).toEqual(RELEASED);
    }
  });

  it('空白区切りの時刻も同じ厳しさで見る（T 区切りだけを見ない）', () => {
    // 時刻レンジ検査は 1 箇所へ寄せたので、区切り文字を取りこぼすと受け皿が無くなる。
    expect(expiresAtMs('2026-07-22 25:00', 'Asia/Tokyo')).toBeNaN();
    expect(expiresAtMs('2026-07-22 12:60', 'Asia/Tokyo')).toBeNaN();
    expect(expiresAtMs('2026-07-22 12:00', 'Asia/Tokyo')).not.toBeNaN();
  });

  it('秒を省いた値・日付だけの値は従来どおり解釈できる', () => {
    expect(stateOf(at('2026-07-22T13:00'), 'bedrock', IN_HOURS)).toEqual(APPLIED);
    expect(stateOf(at('2026-07-23'), 'bedrock', IN_HOURS)).toEqual(APPLIED);
  });
});

/*
 * ---------------------------------------------------------------------------
 * #798 AC2: 解析不能な一時 override の倒し方を state 依存にする
 * ---------------------------------------------------------------------------
 */

/**
 * 承認された表そのもの（#798 の 2026-08-31 コメント）。**仕様の宣言はここ 1 箇所だけ**にする。
 * 各ケースの期待値は分岐ごとに手で書かず、下の 2 つの不変条件から導く:
 *
 *   - `retained` … その override が**勝つ**（下位の段が何を言おうと state / reason が override）
 *   - `released` … **override が最初から無かった場合と完全に一致**する（自動解除の最強の定義）
 */
const DISPOSAL_OF_UNPARSABLE = {
  force_running: 'released',
  force_stopped: 'retained',
  draining: 'retained',
} as const satisfies Record<TemporaryOverride['state'], 'released' | 'retained'>;

const OVERRIDDEN_STATE = {
  force_running: 'running',
  force_stopped: 'stopped',
  draining: 'draining',
} as const satisfies Record<TemporaryOverride['state'], ServiceRuntimeState>;

const ALL_OVERRIDE_STATES = Object.keys(DISPOSAL_OF_UNPARSABLE) as TemporaryOverride['state'][];

/**
 * 「解析不能」の**総当たり**。構文の壊れ方（前方一致・暦・時刻・桁）と型ドリフト（DynamoDB の
 * 属性型違い・部分書き込み・旧スキーマ）を両方入れる。1 形だけで確かめると、`expiresAtMs` の
 * どこか 1 段を通る壊れ方だけが縛られ、他の段が素通りする。
 */
const MALFORMED_EXPIRES_AT: readonly unknown[] = [
  // 構文（前方一致で通してはいけないもの・空値）
  'not-a-date',
  '',
  '   ',
  '2026-07-22T12:00oops',
  '2026-07-22extra',
  '2026/07/22T12:00',
  // 暦として存在しない（`Date` が黙って繰り上げる形）
  '2026-13-01',
  '2026-02-30',
  '2026-00-10',
  '2026-07-32',
  '2027-02-29',
  '0000-01-01',
  '2027-02-30T00:00:00Z',
  '2027-02-30T00:00:00+09:00',
  // 時刻として存在しない（オフセットの有無で差を作らない）
  '2027-07-22T24:00',
  '2027-07-22T12:60',
  '2027-07-22T12:00:60',
  '2027-07-22T24:00:00Z',
  '2027-07-22T12:60:00Z',
  // 桁（ミリ秒 4 桁以上は padEnd が効かず大幅な延長になる）
  '2027-07-22T13:00:00.1234',
  // 型ドリフト
  null,
  undefined,
  123,
  0,
  true,
  {},
  [],
  Number.NaN,
];

/** bedrock にだけ一時 override を載せたポリシー。 */
function withOverride(state: TemporaryOverride['state'], expiresAt: unknown): RuntimeOperatingPolicy {
  return policyWith({ bedrock: { temporaryOverride: { state, expiresAt: expiresAt as string } } });
}

/** override が無いときの解決（＝「解除された」の正解）。 */
function baselineServices(now: number) {
  return resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now }).services;
}

/** override が勝ったときの解決（bedrock 以外は baseline のまま＝他サービスを巻き込まない）。 */
function servicesWithOverrideWinning(now: number, state: TemporaryOverride['state']) {
  return baselineServices(now).map((service) =>
    service.serviceKey === 'bedrock'
      ? {
          serviceKey: 'bedrock' as const,
          mode: service.mode,
          state: OVERRIDDEN_STATE[state],
          reason: 'temporary_override' as const,
        }
      : service,
  );
}

describe('AC2 解析不能な一時 override は state で倒し方を変える (#798)', () => {
  /*
   * 代表点を 2 つ使う。営業時間内（下位の段は running）と営業時間外（下位の段は stopped）で、
   * 「維持」と「解除」がそれぞれ別の値になる。片方だけだと、state が偶然一致して空虚に通る。
   */
  const EVALUATION_POINTS = [IN_HOURS, OUT_OF_HOURS];

  it('この fixture では「維持」と「解除」が必ず別の値になる（空虚な合格の予防）', () => {
    for (const now of EVALUATION_POINTS) {
      for (const state of ALL_OVERRIDE_STATES) {
        expect(servicesWithOverrideWinning(now, state), `${state}@${now}`).not.toEqual(baselineServices(now));
      }
    }
  });

  it('壊れ方を総当たりしても、倒れ方は override の state だけで決まる', () => {
    for (const now of EVALUATION_POINTS) {
      for (const state of ALL_OVERRIDE_STATES) {
        const expected =
          DISPOSAL_OF_UNPARSABLE[state] === 'retained' ? servicesWithOverrideWinning(now, state) : baselineServices(now);
        for (const bad of MALFORMED_EXPIRES_AT) {
          expect(
            resolveServiceStates({ policy: withOverride(state, bad), now }).services,
            `${state} / ${String(bad)} / ${now}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it('期限切れ（解析できた値）は 3 つの state すべてで従来どおり自動解除する', () => {
    /*
     * 🔴 下界。「維持」を state 依存にした結果、**解析できた期限切れまで維持する**と
     * 一時 override が永久 override に化ける。`expiresAt <= now` の契約は変えていない。
     */
    for (const now of EVALUATION_POINTS) {
      for (const state of ALL_OVERRIDE_STATES) {
        for (const expiresAt of [new Date(now - 60_000).toISOString(), new Date(now).toISOString()]) {
          const result = resolveServiceStates({ policy: withOverride(state, expiresAt), now });
          expect(result.services, `${state} / ${expiresAt}`).toEqual(baselineServices(now));
          expect(result.anomalies, `${state} / ${expiresAt}`).toEqual([]);
        }
      }
    }
  });

  it('期限内（解析できた値）は 3 つの state すべてで適用する', () => {
    // 上界。「解除」側の実装が何もしなくなっていないことを対で縛る。
    for (const now of EVALUATION_POINTS) {
      for (const state of ALL_OVERRIDE_STATES) {
        const expiresAt = new Date(now + 60_000).toISOString();
        const result = resolveServiceStates({ policy: withOverride(state, expiresAt), now });
        expect(result.services, `${state} / ${expiresAt}`).toEqual(servicesWithOverrideWinning(now, state));
        expect(result.anomalies, `${state} / ${expiresAt}`).toEqual([]);
      }
    }
  });

  it('壊れた timezone 経由の解析不能でも倒し方は同じ（壊れ方の経路に依らない）', () => {
    /*
     * `expiresAt` 自体は正しい書式なのに、**同じレコードの `timezone` が壊れていて**現地時刻と
     * して解釈できない形。`expiresAt` の書式検査だけを塞いでも消えない経路なので、ここも同じ表で
     * 倒れることを縛る。段 5 は不正 TZ で throw するので、schedule を読まない mode の registry
     * 部分集合で見る。
     */
    const onlyBedrock: readonly ManagedRuntimeService[] = [
      { serviceKey: 'bedrock', defaultMode: 'manual_only', dependsOn: [], provides: ['ai_intent_resolution'] },
    ];
    const now = IN_HOURS; // 2026-07-22 10:00 JST
    // オフセットを持たない値だけが timezone を要る（`Z` 付きは絶対時刻として読めてしまう）。
    const localExpiresAt = '2026-07-22T13:00';
    const policyIn = (timezone: string, state: TemporaryOverride['state']): RuntimeOperatingPolicy => ({
      commonSchedule: { ...COMMON_8_23, timezone },
      services: { bedrock: { temporaryOverride: { state, expiresAt: localExpiresAt } } },
    });
    for (const state of ALL_OVERRIDE_STATES) {
      // 対照: timezone が正しければ同じ値が「期限内」として解釈でき、異常も出ない。
      const healthy = resolveServiceStates({ policy: policyIn('Asia/Tokyo', state), services: onlyBedrock, now });
      expect(healthy.services, state).toEqual([
        { serviceKey: 'bedrock', mode: 'manual_only', state: OVERRIDDEN_STATE[state], reason: 'temporary_override' },
      ]);
      expect(healthy.anomalies, state).toEqual([]);

      const broken = resolveServiceStates({ policy: policyIn('Not/A/Zone', state), services: onlyBedrock, now });
      const retained = DISPOSAL_OF_UNPARSABLE[state] === 'retained';
      expect(broken.services, state).toEqual([
        {
          serviceKey: 'bedrock',
          mode: 'manual_only',
          state: retained ? OVERRIDDEN_STATE[state] : 'stopped',
          reason: retained ? 'temporary_override' : 'default_policy',
        },
      ]);
      expect(
        broken.anomalies.map((anomaly) => anomaly.disposition),
        state,
      ).toEqual([DISPOSAL_OF_UNPARSABLE[state]]);
    }
  });
});

describe('AC2 解析不能な override は観測できる（無言で捨てない・無言で維持しない） (#798)', () => {
  it('壊れ方を総当たりしても 1 件だけ、どのサービスをどう倒したかが載る', () => {
    for (const state of ALL_OVERRIDE_STATES) {
      for (const bad of MALFORMED_EXPIRES_AT) {
        const result = resolveServiceStates({ policy: withOverride(state, bad), now: IN_HOURS });
        expect(result.anomalies, `${state} / ${String(bad)}`).toEqual([
          {
            kind: 'unparsable_override_expiry',
            serviceKey: 'bedrock',
            overrideState: state,
            disposition: DISPOSAL_OF_UNPARSABLE[state],
            expiresAt: expect.any(String),
          },
        ]);
      }
    }
  });

  it('報告した disposition は実際の倒れ方と一致する（報告と挙動を乖離させない）', () => {
    /*
     * 🔴 表と実装を別々に手で書くと、片方だけ直したときに**「維持した」と報告しながら解除する**
     * （またはその逆）状態が作れてしまう。報告を挙動から検算する。
     */
    for (const now of [IN_HOURS, OUT_OF_HOURS]) {
      for (const state of ALL_OVERRIDE_STATES) {
        for (const bad of MALFORMED_EXPIRES_AT) {
          const result = resolveServiceStates({ policy: withOverride(state, bad), now });
          const bedrock = resolutionFor(result, 'bedrock');
          const reportedRetained = result.anomalies[0]?.disposition === 'retained';
          const actuallyRetained = bedrock?.reason === 'temporary_override' && bedrock.state === OVERRIDDEN_STATE[state];
          expect(reportedRetained, `${state} / ${String(bad)} / ${now}`).toBe(actuallyRetained);
        }
      }
    }
  });

  it('壊れていなければ何も報告しない（正常時に鳴らさない）', () => {
    expect(resolveServiceStates({ policy: { commonSchedule: COMMON_8_23 }, now: IN_HOURS }).anomalies).toEqual([]);
    expect(
      resolveServiceStates({ policy: policyWith({ bedrock: { mode: 'manual_only' } }), now: IN_HOURS }).anomalies,
    ).toEqual([]);
  });

  it('複数サービスが壊れていたら registry 順に全部載る（1 件で打ち切らない）', () => {
    const policy = policyWith({
      stt: { temporaryOverride: { state: 'force_running', expiresAt: 'not-a-date' } },
      bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: 'not-a-date' } },
      monitoring: { temporaryOverride: { state: 'draining', expiresAt: 'not-a-date' } },
    });
    const result = resolveServiceStates({ policy, now: IN_HOURS });
    expect(result.anomalies.map((anomaly) => [anomaly.serviceKey, anomaly.disposition])).toEqual([
      ['stt', 'released'],
      ['bedrock', 'retained'],
      ['monitoring', 'retained'],
    ]);
  });

  it('break-glass で決まったサービスは override を見ていないので報告しない', () => {
    /*
     * 段 1 は段 2 より上で、override は**参照されない**。ここで報告すると
     * 「維持した / 解除した」が実際には起きていない出来事になる（緊急停止中は全件鳴り続ける）。
     */
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: COMMON_8_23,
      breakGlass: { active: true, scope: 'all' },
      services: { bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: 'not-a-date' } } },
    };
    const result = resolveServiceStates({ policy, now: IN_HOURS });
    expect(resolutionFor(result, 'bedrock')).toMatchObject({ state: 'stopped', reason: 'break_glass' });
    expect(result.anomalies).toEqual([]);
  });

  it('報告に載せる expiresAt は上限つきの標本にする（生値をそのまま溜めない）', () => {
    const long = `2026-07-22T12:00${'x'.repeat(500)}`;
    const [anomaly] = resolveServiceStates({ policy: withOverride('force_stopped', long), now: IN_HOURS }).anomalies;
    expect(anomaly?.expiresAt.length).toBeLessThanOrEqual(65);
    expect(anomaly?.expiresAt.startsWith('2026-07-22T12:00')).toBe(true);
  });

  it('文字列でない値は型名で報告する（`[object Object]` のような無情報にしない）', () => {
    const sampleFor = (value: unknown) =>
      resolveServiceStates({ policy: withOverride('force_stopped', value), now: IN_HOURS }).anomalies[0]?.expiresAt;
    expect(sampleFor(null)).toBe('<null>');
    expect(sampleFor(undefined)).toBe('<undefined>');
    expect(sampleFor(123)).toBe('<number>');
    expect(sampleFor({})).toBe('<object>');
    expect(sampleFor([])).toBe('<object>');
  });
});
