/**
 * runtime policy（サービス単位の稼働ポリシー）ストアのテスト (#367)。
 *
 * 共通営業時間（`operating_policy`）とは**別コレクション**に置く。理由は保存の原子性:
 * 1 コレクションに統合すると稼働中の kiosk consumer（`kiosk-gate` / `call-guard`）を
 * 巻き込む移行が要り、両方へ書き分けると「営業時間だけ更新されてサービス設定が古い」
 * 状態を作れてしまう。合成は**読み出し時**に行う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appendAuditLog = vi.fn();
const appendAdminAudit = vi.fn();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAuditLog: (...a: unknown[]) => appendAuditLog(...a),
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));

import { __resetOperatingPolicyStore, upsertOperatingPolicy } from '@/lib/operating-policy/store';
import type { ManagedRuntimeService } from '@/domain/runtime-policy/registry';
import {
  expiresAtMs,
  resolutionFor,
  resolveServiceStates,
  type CommonSchedule,
  type RuntimeOperatingPolicy,
  type ServiceResolution,
} from '@/domain/runtime-policy/resolve';
import { getBackend } from '@/lib/data';
import {
  __resetRuntimePolicyStore,
  getRuntimePolicy,
  resolveRuntimeStatesFor,
  runtimePolicyKey,
  unresolvedWithoutCommonSchedule,
  upsertRuntimePolicy,
} from './store';

const TENANT = 't1';
const SITE = 's1';
/** 月曜 10:00 JST（営業時間内）。 */
const IN_HOURS = Date.parse('2026-07-20T01:00:00Z');

async function seedOperatingHours(): Promise<void> {
  const result = await upsertOperatingPolicy(TENANT, SITE, 'admin@example.com', {
    timezone: 'Asia/Tokyo',
    weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    fixedHolidays: [],
    exceptionDates: [],
  });
  if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result.error)}`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  appendAdminAudit.mockResolvedValue(undefined);
  appendAuditLog.mockResolvedValue(undefined);
  await __resetRuntimePolicyStore();
  await __resetOperatingPolicyStore();
});

afterEach(async () => {
  await __resetRuntimePolicyStore();
  await __resetOperatingPolicyStore();
});

describe('getRuntimePolicy', () => {
  it('未設定なら null（registry の既定 mode で動く、という意味）', async () => {
    await expect(getRuntimePolicy(TENANT, SITE)).resolves.toBeNull();
  });
});

describe('upsertRuntimePolicy', () => {
  it('サービス設定を保存し、読み戻せる', async () => {
    await seedOperatingHours();
    const result = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { stt: { mode: 'manual_only' } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(1);
    await expect(getRuntimePolicy(TENANT, SITE)).resolves.toMatchObject({
      services: { stt: { mode: 'manual_only' } },
    });
  });

  /**
   * 🔴 #798 AC5。隣接する `operating-policy` の route/store は封筒
   * （`tenantId` / `siteId` / `expectedVersion`）を**同じ body に載せて**渡す作法。
   * 検証器はポリシー文書だけを受け取り未知キーを拒否するので、剥がさずに渡すと
   * **繋いだ瞬間に全リクエストが 400** になる。剥がすのはこの層の責務。
   */
  it('route 層の封筒を剥がしてから検証する', async () => {
    await seedOperatingHours();
    const created = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      tenantId: TENANT,
      siteId: SITE,
      services: { stt: { mode: 'manual_only' } },
    });
    expect(created.ok).toBe(true);
    const updated = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      tenantId: TENANT,
      siteId: SITE,
      expectedVersion: 1,
      services: { stt: { mode: 'always_on' } },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.version).toBe(2);
  });

  it('共通営業時間はこの経路で書かせない（黙って無視しない）', async () => {
    await seedOperatingHours();
    const result = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      commonSchedule: { timezone: 'UTC', weeklySchedule: {}, fixedHolidays: [], exceptionDates: [] },
      services: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.issues.map((i) => i.field)).toContain('commonSchedule');
    }
  });

  it('サービス設定の契約は共通営業時間の有無によらず同じ', async () => {
    /*
     * 検証に固定値を被せる判断の根拠そのもの。**両側**で同じ issue が出ることを固定しないと、
     * 「実物を読んでも受理集合は変わらない」という散文が機械で守られない。
     */
    const input = { services: { stt: { mode: 'custom_schedule', weeklySchedule: {} } } };
    const withoutCommon = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', input);
    await seedOperatingHours();
    const withCommon = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', input);
    expect(withoutCommon.ok).toBe(false);
    expect(withCommon.ok).toBe(false);
    if (withoutCommon.ok || withCommon.ok) return;
    expect(withoutCommon.error.issues).toEqual(withCommon.error.issues);
    expect(withCommon.error.issues.map((i) => i.field)).toContain('services.stt.weeklySchedule');
  });

  it('共通営業時間が未設定でもサービス設定は保存できる', async () => {
    // 順序を強制しない（運用者がどちらを先に触るかは決められない）。
    const result = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { stt: { mode: 'manual_only' } },
    });
    expect(result.ok).toBe(true);
  });

  describe('楽観ロック', () => {
    it('既存更新に expectedVersion を必須にする（後勝ちの経路を残さない）', async () => {
      await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
      const result = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', { services: {} });
      expect(result.ok).toBe(false);
      // 🔴 code だけ見ると CAS 側の 409 と区別が付かない。運用者への指示が別物
      // （「version を送れ」と「読み直して再試行せよ」）なので message まで固定する。
      if (!result.ok) {
        expect(result.error.code).toBe('conflict');
        expect(result.error.message).toContain('expectedVersion is required');
      }
    });

    it('version 不一致は conflict', async () => {
      await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
      const result = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', {
        expectedVersion: 99,
        services: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('conflict');
        expect(result.error.message).toContain('updated by someone else');
      }
    });

    it('存在しないのに expectedVersion が来たら作成へ倒さない', async () => {
      const result = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
        expectedVersion: 1,
        services: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('conflict');
        expect(result.error.message).toContain('does not exist');
      }
    });

    it('expectedVersion の型不正は conflict ではなく invalid_input', async () => {
      // 409 は「読み直して再試行せよ」の意味。型が違う要求は何度やっても直らない。
      await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
      for (const bad of ['1', 1.5, -1, null, true]) {
        const result = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', {
          expectedVersion: bad,
          services: {},
        });
        expect(result.ok, String(bad)).toBe(false);
        if (!result.ok) {
          expect(result.error.code, String(bad)).toBe('invalid_input');
          expect(result.error.issues.map((i) => i.field)).toContain('expectedVersion');
        }
      }
    });
  });

  /**
   * 🔴 `updateIf` は**マージ**、`put` は置換。省略された任意フィールドを `undefined` で
   * 明示しないと旧値が残り、API は「消えた」と答えるのに永続状態には古い設定が居座る。
   * break-glass が消えないと、解除したはずの緊急停止が毎分の解決で復活する。
   */
  it('省略したフィールドは消える（更新でも旧値が残らない）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { mode: 'manual_only' } },
      breakGlass: { active: true, serviceKeys: ['stt'] },
    });
    const result = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      expectedVersion: 1,
      services: { stt: { mode: 'always_on' } },
    });
    expect(result.ok).toBe(true);
    const stored = await getRuntimePolicy(TENANT, SITE);
    expect(stored?.breakGlass).toBeUndefined();
  });

  it('省略したサービス設定も消える（breakGlass 側だけ守っても意味がない）', async () => {
    /*
     * PUT は文書の全置換。緊急時に手で叩かれる「break-glass だけの最小 body」が全サービスの
     * 週間スケジュールを消すので、消えること自体を機械で固定しておく（route/UI は全文書を
     * 送る契約にする。#798）。
     */
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { mode: 'custom_schedule', weeklySchedule: { mon: [{ start: '09:00', end: '12:00' }] } } },
    });
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      expectedVersion: 1,
      breakGlass: { active: true },
    });
    const stored = await getRuntimePolicy(TENANT, SITE);
    expect(stored?.services).toBeUndefined();
  });

  it('同時に初回作成しても片方が無言で消えない', async () => {
    // `get` → 無ければ `put` は原子的でない。消えるのが緊急停止なら「止めたつもり」が残る。
    const [a, b] = await Promise.all([
      upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { breakGlass: { active: true } }),
      upsertRuntimePolicy(TENANT, SITE, 'b@example.com', { services: { stt: { mode: 'manual_only' } } }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const stored = await getRuntimePolicy(TENANT, SITE);
    expect(stored?.version).toBe(1);
  });

  it('封筒のスコープが認可済みスコープと食い違ったら弾く（黙って捨てない）', async () => {
    const result = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      tenantId: 'other-tenant',
      services: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.map((i) => i.field)).toContain('tenantId');
    const site = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { siteId: 'other-site', services: {} });
    expect(site.ok).toBe(false);
  });

  it('保存するスコープと実施者は引数（認可済み）由来', async () => {
    const result = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', { services: {} });
    expect(result.ok).toBe(true);
    const stored = await getRuntimePolicy(TENANT, SITE);
    expect(stored).toMatchObject({ tenantId: TENANT, siteId: SITE, updatedBy: 'admin@example.com' });
    expect(Date.parse(stored?.updatedAt ?? '')).toBeGreaterThan(0);
  });

  it('キー成分に区切り文字を含む値を拒否する（別スコープと衝突させない）', () => {
    // `a:b` + `c` と `a` + `b:c` が同じキーになると、別サイトの設定を読み書きしてしまう。
    expect(() => runtimePolicyKey('a:b', 'c')).toThrow();
    expect(() => runtimePolicyKey('a', 'b:c')).toThrow();
    expect(runtimePolicyKey('a', 'b')).toBe('a:b');
  });

  it('監査に時間帯の具体値を残さない（誰がどのサービスを触ったかまで）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { stt: { mode: 'custom_schedule', weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] } } },
    });
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = appendAuditLog.mock.calls[0] as [{ action: string; actor: string; targetType: string; metadata: Record<string, string> }];
    expect(entry.action).toBe('runtime_policy.updated');
    expect(entry.targetType).toBe('runtime_policy');
    // 実施者は actor 側（metadata へ入れると監査 API の PII サニタイザを素通りする）。
    expect(entry.actor).toBe('admin:admin@example.com');
    expect(entry.metadata.configuredServiceKeys).toBe('stt');
    expect(JSON.stringify(entry.metadata)).not.toContain('09:00');
  });

  it('複数サービスの監査は並び順を固定する（差分レビューが安定するように）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { signage: { mode: 'always_on' }, bedrock: { mode: 'manual_only' } },
    });
    const [entry] = appendAuditLog.mock.calls[0] as [{ metadata: Record<string, string> }];
    expect(entry.metadata.configuredServiceKeys).toBe('bedrock,signage');
  });

  it('break-glass の範囲を監査に残す（対象なしと全停止を取り違えない）', async () => {
    /*
     * 🔴 `breakGlass.serviceKeys` の省略は「保護対象以外を**全部**止める」を意味する。
     * サービス個別設定のキー（`configuredServiceKeys`）と同じ欄で表すと、全停止が
     * 「何も止まっていない」と読める監査行になる。
     */
    const scopeOf = () => (appendAuditLog.mock.calls[0] as [{ metadata: Record<string, string> }])[0].metadata;

    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', { breakGlass: { active: true } });
    expect(scopeOf().breakGlass).toBe('active');
    expect(scopeOf().breakGlassScope).toBe('all_unprotected');

    // 空配列も「保護対象以外を全停止」（`resolve.ts` の契約）。'' と記録して誤読させない。
    vi.clearAllMocks();
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      expectedVersion: 1,
      breakGlass: { active: true, serviceKeys: [] },
    });
    expect(scopeOf().breakGlassScope).toBe('all_unprotected');

    vi.clearAllMocks();
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      expectedVersion: 2,
      breakGlass: { active: true, serviceKeys: ['stt'] },
    });
    expect(scopeOf().breakGlassScope).toBe('stt');

    // 解除（active: false）は「範囲なし」。
    vi.clearAllMocks();
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      expectedVersion: 3,
      breakGlass: { active: false },
    });
    expect(scopeOf().breakGlass).toBe('inactive');
    expect(scopeOf().breakGlassScope).toBe('none');
  });

  it('「存在しないのに expectedVersion」も監査に残さない（実装ミス由来）', async () => {
    const result = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      expectedVersion: 1,
      services: {},
    });
    expect(result.ok).toBe(false);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it('競合監査に理由を残す（どの競合だったか事後に分かるように）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
    vi.clearAllMocks();
    await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', { expectedVersion: 99, services: {} });
    const [entry] = appendAuditLog.mock.calls[0] as [{ metadata: Record<string, string> }];
    expect(entry.metadata.reason).toContain('updated by someone else');
  });

  it('成功したのに監査で落ちて 500 にならない', async () => {
    // 保存は成功したのに 500 が返ると、運用者は再送して 409 を受け「止められなかった」と読む。
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      appendAuditLog.mockRejectedValueOnce(new Error('audit down'));
      const result = await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
      expect(result.ok).toBe(true);
      // どの拠点の監査行が欠落したかを特定できること（`targetId` は `<tenantId>:<siteId>`）。
      expect(error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ targetId: `${TENANT}:${SITE}` }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('同時編集の競合は監査に残す（クライアントの実装ミスは残さない）', async () => {
    // 「2 人が同時に触った」だけを残す。実装ミス由来の 409 まで残すと、リトライで線形に増えて
    // 本命の同時編集イベントが埋もれる。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
    vi.clearAllMocks();
    const stale = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', {
      expectedVersion: 99,
      services: {},
    });
    expect(stale.ok).toBe(false);
    const [entry] = appendAuditLog.mock.calls[0] as [{ action: string; actor: string; targetId: string }];
    expect(entry.action).toBe('runtime_policy.update_conflicted');
    expect(entry.actor).toBe('admin:b@example.com');
    expect(entry.targetId).toBe(`${TENANT}:${SITE}`);

    vi.clearAllMocks();
    const missingVersion = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', { services: {} });
    expect(missingVersion.ok).toBe(false);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it('監査の失敗で 409 を 500 に化けさせない', async () => {
    // 「読み直して再試行せよ」は返せるのに返せなくなるのが、緊急時に一番困る壊れ方。
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: {} });
      appendAuditLog.mockRejectedValueOnce(new Error('audit down'));
      const result = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', {
        expectedVersion: 99,
        services: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('conflict');
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('unresolvedWithoutCommonSchedule', () => {
  /**
   * 現 registry の依存は深さ 1（stt / dynamic-tts → realtime-conversation）なので、
   * 「推移的に辿る」主張は**単一パスでも同じ結果**になり、閉包そのものが縛られない。
   * 擬似 registry で 3 段の連鎖を作って固定する（registry に 2 段依存が入った日に静かに壊れないよう）。
   */
  it('2 段以上の依存も辿る（不動点まで回す）', () => {
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
      { serviceKey: 'c', defaultMode: 'always_on', dependsOn: ['b'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'follow_operating_hours', state: 'stopped', reason: 'common_weekly_schedule' },
      { serviceKey: 'b', mode: 'always_on', state: 'running', reason: 'default_policy' },
      { serviceKey: 'c', mode: 'always_on', state: 'running', reason: 'default_policy' },
    ] as unknown as ServiceResolution[];
    const unresolved = unresolvedWithoutCommonSchedule(services, undefined, IN_HOURS, chain);
    expect([...unresolved].sort()).toEqual(['a', 'b', 'c']);
  });

  it('確定停止が連鎖の途中にあっても、その先を辿る', () => {
    // skip の `continue` を `break` にすると `c` が漏れる。「確定停止」と「連鎖」を
    // 組み合わせないと、この分岐は縛れない。
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'c', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'follow_operating_hours', state: 'stopped', reason: 'common_weekly_schedule' },
      { serviceKey: 'b', mode: 'manual_only', state: 'stopped', reason: 'default_policy' },
      { serviceKey: 'c', mode: 'always_on', state: 'running', reason: 'default_policy' },
    ] as unknown as ServiceResolution[];
    const unresolved = unresolvedWithoutCommonSchedule(services, undefined, IN_HOURS, chain);
    expect([...unresolved].sort()).toEqual(['a', 'c']);
  });

  it('registry が依存の逆順に並んでいても閉包が閉じる（不動点まで回す）', () => {
    // 順方向に並んだ registry だと 1 パスでも同じ結果になり、不動点性が縛れない。
    const chain = [
      { serviceKey: 'c', defaultMode: 'always_on', dependsOn: ['b'], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'c', mode: 'always_on', state: 'running', reason: 'default_policy' },
      { serviceKey: 'b', mode: 'always_on', state: 'running', reason: 'default_policy' },
      { serviceKey: 'a', mode: 'follow_operating_hours', state: 'stopped', reason: 'common_weekly_schedule' },
    ] as unknown as ServiceResolution[];
    expect([...unresolvedWithoutCommonSchedule(services, undefined, IN_HOURS, chain)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('確定 draining は飲み込む（stopped ほど強くないので依存先しだいで変わる）', () => {
    // skip 節を `!== 'running'` に緩めると draining まで確定扱いになる。severity は
    // stopped が最大で draining はその下なので、依存先が判定不能なら値は動きうる。
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'follow_operating_hours', state: 'running', reason: 'common_weekly_schedule' },
      { serviceKey: 'b', mode: 'always_on', state: 'draining', reason: 'temporary_override' },
    ] as unknown as ServiceResolution[];
    const overrides = {
      b: { temporaryOverride: { state: 'draining', expiresAt: '2026-07-20T23:00:00Z' } },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)].sort()).toEqual(['a', 'b']);
  });

  it('例外日を持っていても、有効な override で決まったなら確定扱い', () => {
    // 段 2 で決まった時点で段 3 は走らない。例外日の有無で判定不能にすると、
    // 「今すぐ止める」が例外日を設定した拠点でだけ効かなくなる。
    const chain = [
      { serviceKey: 'a', defaultMode: 'custom_schedule', dependsOn: [], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'custom_schedule', state: 'stopped', reason: 'temporary_override' },
    ] as unknown as ServiceResolution[];
    const overrides = {
      a: {
        exceptionDates: [{ date: '2026-07-21', closed: true }],
        temporaryOverride: { state: 'force_stopped', expiresAt: '2030-01-01T00:00:00Z' },
      },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)]).toEqual([]);
  });

  it('補正で確定停止になった側は、自分の override の失効判定が TZ 依存でも確定扱い', () => {
    /*
     * 🔴 `dependency_correction` の早期 return は**段 2 より前**でなければならない。段 2 の
     * 後ろへ動かすと（「早期 return は失効判定より後が自然」という一見もっともな整理で
     * 起こりうる）、スコープ付き break-glass で止めたサービスに依存する側が、過去に一度でも
     * 現地時刻の override を使っていただけで判定不能に吸い込まれる——一度直した回帰の再発。
     */
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'manual_only', state: 'stopped', reason: 'break_glass' },
      {
        serviceKey: 'b',
        mode: 'always_on',
        state: 'stopped',
        reason: 'dependency_correction',
        correction: { blockedBy: 'a', from: { state: 'running', reason: 'temporary_override' } },
      },
    ] as unknown as ServiceResolution[];
    // 01:00Z 時点で、TZ の両端で有効/失効が割れる期限。
    const overrides = {
      b: { temporaryOverride: { state: 'force_running', expiresAt: '2026-07-20T05:00' } },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)]).toEqual([]);
  });

  it('例外日が空配列なら段 3 は発火しない（`!== undefined` に緩めない）', () => {
    // 管理画面で例外日の行を全部消すと `[]` がそのまま保存される。`!== undefined` で判定すると、
    // 一度でも例外日を設定して消したサービスが恒久的に判定不能になる。
    const chain = [
      { serviceKey: 'a', defaultMode: 'custom_schedule', dependsOn: [], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'custom_schedule', state: 'stopped', reason: 'default_policy' },
    ] as unknown as ServiceResolution[];
    const overrides = { a: { exceptionDates: [] } } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)]).toEqual([]);
  });

  it('期限がちょうど境界に載るときは判定不能（`>` と `>=` を取り違えない）', () => {
    /*
     * `resolve.ts` の自動解除は `expiresAt <= now`。`>=` で比較すると、東端の拠点では
     * 失効・西端では有効という割れた状態を「確定」と報告する（過剰確定＝危険な向き）。
     */
    const local = '2026-07-21T20:00';
    const now = expiresAtMs(local, '+23:59');
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'always_on', state: 'stopped', reason: 'temporary_override' },
    ] as unknown as ServiceResolution[];
    const overrides = {
      a: { temporaryOverride: { state: 'force_stopped', expiresAt: local } },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, now, chain)]).toEqual(['a']);
  });

  it('例外日を持っていても、スケジュールを読まない mode なら確定扱い', () => {
    // `always_on` / `manual_only` は段 3 を通らないので、例外日は無視される（＝結論は TZ に依らない）。
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'always_on', state: 'running', reason: 'default_policy' },
    ] as unknown as ServiceResolution[];
    const overrides = {
      a: { exceptionDates: [{ date: '2026-07-21', closed: true }] },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)]).toEqual([]);
  });

  it('補正で確定停止になった側は、自分の判断が TZ 依存でも確定扱い', () => {
    // 補正は severity を上げることしかできないので、stopped へ補正された時点で値は不変。
    // ここを補正前の reason で seed すると、確定しているものまで判定不能になる（過剰拒否）。
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'manual_only', state: 'stopped', reason: 'break_glass' },
      {
        serviceKey: 'b',
        mode: 'custom_schedule',
        state: 'stopped',
        reason: 'dependency_correction',
        correction: { blockedBy: 'a', from: { state: 'running', reason: 'common_weekly_schedule' } },
      },
    ] as unknown as ServiceResolution[];
    // 例外日を持っていても同じ（補正で最大 severity に張り付いた時点で値は動かない）。
    const overrides = {
      b: { exceptionDates: [{ date: '2026-07-21', closed: true }] },
    } as unknown as RuntimeOperatingPolicy['services'];
    expect([...unresolvedWithoutCommonSchedule(services, overrides, IN_HOURS, chain)]).toEqual([]);
  });

  it('解決に含まれないサービスは辿らない（部分集合で呼ばれても増やさない）', () => {
    const chain = [
      { serviceKey: 'a', defaultMode: 'always_on', dependsOn: [], provides: [] },
      { serviceKey: 'b', defaultMode: 'always_on', dependsOn: ['a'], provides: [] },
    ] as unknown as ManagedRuntimeService[];
    const services = [
      { serviceKey: 'a', mode: 'follow_operating_hours', state: 'stopped', reason: 'common_weekly_schedule' },
    ] as unknown as ServiceResolution[];
    expect([...unresolvedWithoutCommonSchedule(services, undefined, IN_HOURS, chain)]).toEqual(['a']);
  });
});

/**
 * 🔴 **この increment が 5 周振れた理由への対処。**
 *
 * 「どの段が TZ に依るか」を人が段ごとに導くたびに、述語とコードが**同じ誤りを共有**して
 * しまい、行単位の変異では検出できなかった（既存テストが全部「捏造 Asia/Tokyo の世界」を
 * 正解として書かれているため）。導出をやめて、**満たすべき不変条件そのもの**を縛る。
 *
 *   判定不能に入っていない ⟹ 拠点 TZ と共通営業時間が何であっても state が一致する
 */
describe('判定不能の切り分けの不変条件', () => {
  /*
   * 名前付きゾーン（-12〜+14）だけでは、境界を**名前付きの範囲まで狭める**変異を検出できない。
   * このシステムは生オフセット（±23:59）も受理して保存するので、実際の両端まで入れる。
   */
  const TIMEZONES = ['-23:59', 'Etc/GMT+12', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo', 'Etc/GMT-14', '+23:59'];
  const WEEKLY: CommonSchedule['weeklySchedule'][] = [
    {},
    { mon: [{ start: '09:00', end: '18:00' }] },
    { mon: [{ start: '00:00', end: '23:59' }], tue: [{ start: '00:00', end: '23:59' }] },
  ];
  /*
   * 期限内（絶対/現地）・失効済み（絶対/現地）・境界をまたぐ現地時刻に加えて、
   * **TZ 境界のすぐ内側**を必ず入れる。ここを踏まないと、両端を狭める変異
   * （＝過剰確定）が素通りする——境界の緊さは fixture でしか縛れない。
   */
  const EXPIRES = [
    '2030-01-01T00:00:00Z',
    '2026-07-21T20:30',
    '2020-01-01T00:00',
    '2026-07-20T23:00:00Z',
    '2020-01-01T00:00:00Z',
    // now = 2026-07-21T20:00Z に対し、-23:59 の拠点でだけ未来（境界の 30 分内側）。
    '2026-07-20T20:30',
    // +23:59 の拠点でだけ失効（同じく 30 分内側）。
    '2026-07-22T19:30',
  ];
  const OVERRIDE_STATES = ['force_running', 'force_stopped', 'draining'] as const;

  function fixtures(): RuntimeOperatingPolicy['services'][] {
    const out: RuntimeOperatingPolicy['services'][] = [undefined as never];
    for (const mode of ['always_on', 'manual_only', 'follow_operating_hours', 'custom_schedule'] as const) {
      for (const expiresAt of EXPIRES) {
        for (const state of OVERRIDE_STATES) {
          out.push({
            // 依存元は override、依存先は個別スケジュール——依存補正が絡む形を必ず含める。
            'realtime-conversation': { mode, temporaryOverride: { state, expiresAt } },
            stt: { mode: 'custom_schedule', weeklySchedule: { wed: [{ start: '04:00', end: '08:00' }] } },
          } as RuntimeOperatingPolicy['services']);
        }
      }
      out.push({
        'realtime-conversation': {
          mode,
          exceptionDates: [{ date: '2026-07-21', closed: false, ranges: [{ start: '00:00', end: '23:59' }] }],
        },
      } as RuntimeOperatingPolicy['services']);
    }
    return out;
  }

  it('確定と報告した state は、拠点 TZ と共通営業時間に依らない', () => {
    const now = Date.parse('2026-07-21T20:00:00Z');
    const violations: string[] = [];
    for (const services of fixtures()) {
      const unknown = resolveServiceStates({
        policy: { commonSchedule: { timezone: 'Asia/Tokyo', weeklySchedule: {}, fixedHolidays: [], exceptionDates: [] }, ...(services ? { services } : {}) },
        now,
      });
      const unresolved = unresolvedWithoutCommonSchedule(unknown.services, services, now);
      const confirmed = unknown.services.filter((s) => !unresolved.has(s.serviceKey));

      /*
       * 🔴 **下界も縛る。** 不変条件は片側（過剰確定）しか主張しないので、判定不能を
       * 広げるだけの変異は空虚に満たせてしまう。設定を一切持たないサービスは、
       * 共通営業時間が無くても必ず確定側に居る（`always_on` は mode だけで決まる）。
       */
      const confirmedKeys = confirmed.map((s) => s.serviceKey);
      for (const key of ['admin', 'monitoring', 'qr-resolution'] as const) {
        if (!confirmedKeys.includes(key)) {
          violations.push(`${key} は設定が無いのに判定不能になった / ${JSON.stringify(services)}`);
        }
      }

      for (const timezone of TIMEZONES) {
        for (const weeklySchedule of WEEKLY) {
          const actual = resolveServiceStates({
            policy: { commonSchedule: { timezone, weeklySchedule, fixedHolidays: [], exceptionDates: [] }, ...(services ? { services } : {}) },
            now,
          });
          for (const service of confirmed) {
            const found = resolutionFor(actual, service.serviceKey);
            if (found?.state !== service.state) {
              violations.push(
                `${service.serviceKey} @${timezone}: 確定 ${service.state}(${service.reason}) だが実際は ${found?.state}(${found?.reason}) / ${JSON.stringify(services)}`,
              );
            }
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('resolveRuntimeStatesFor', () => {
  /**
   * 🔴 共通営業時間を実際に読むのは段 5（`follow_operating_hours`）だけ。それが未設定だからと
   * 解決全体を諦めると、**break-glass が「保存できるのに絶対に効かない」**——API は 200、
   * 画面は「停止しました」、監査にも残るのに EC2 は動き続ける。
   */
  it('共通営業時間が未設定でも break-glass は効く', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { breakGlass: { active: true } });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.services.find((s) => s.serviceKey === 'stt')?.state).toBe('stopped');
    // 保護対象は落とさない（止めた後に戻す手段を残す）。
    expect(outcome.services.find((s) => s.serviceKey === 'admin')?.state).toBe('running');
  });

  it('共通営業時間が未設定でも manual_only は効く', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { 'realtime-conversation': { mode: 'manual_only' } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.services.find((s) => s.serviceKey === 'realtime-conversation')?.state).toBe('stopped');
  });

  it('共通営業時間に依存するサービスだけを判定不能として切り分ける', async () => {
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    // 既定が follow_operating_hours のサービスは共通側が要る。always_on 側は決まる。
    expect(outcome.unresolved).toContain('stt');
    expect(outcome.unresolved).not.toContain('signage');
    expect(outcome.services.find((s) => s.serviceKey === 'signage')?.state).toBe('running');
    // 判定できていないサービスを「決まった」側に混ぜない。
    expect(outcome.services.map((s) => s.serviceKey)).not.toContain('stt');
  });

  /**
   * 🔴 依存補正は reason を `dependency_correction` に書き換える。段 5 由来だけを弾いていた頃は、
   * **捏造したスケジュールから生まれた停止指示**が「決まった値」として漏れていた——共通営業時間
   * 未設定の拠点で `stt: always_on` にしても「STT を止めろ」、しかも止める理由になっている
   * realtime-conversation 自身は「触るな」という矛盾した指示になる。
   */
  it('判定不能なサービスに依存するものも判定不能にする（推移的に広げる）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { mode: 'always_on' } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('realtime-conversation');
    expect(outcome.unresolved).toContain('stt');
    // 並びは registry 順（`services` 側と揃える。挿入順だと閉包で足した分が末尾に来る）。
    expect(outcome.unresolved.indexOf('realtime-conversation')).toBeLessThan(outcome.unresolved.indexOf('stt'));
    expect(outcome.unresolved.indexOf('stt')).toBeLessThan(outcome.unresolved.indexOf('bedrock'));
    expect(outcome.services.map((s) => s.serviceKey)).not.toContain('stt');
  });

  it('時刻の解釈が絡む判断は「決まった」と言わない（timezone が分からないため）', async () => {
    // 共通営業時間が無いと拠点の timezone も無い。段 2〜4 も現地時刻の解釈に使うので、
    // 捏造した既定 TZ 由来の結果を確定値として報告しない。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: {
        signage: { mode: 'custom_schedule', weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] } },
      },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('signage');
  });

  /**
   * 🔴 判定不能の集合を**広げ過ぎない**側の表明。依存補正は severity を上げることしかできず、
   * `stopped` は最大値なので、時刻に依らない理由で既に停止しているサービスは依存先が不明でも
   * 値が変わらない。ここを飲み込むと、スコープ付き break-glass が「保存できるのに効かない」に戻る。
   */
  it('確定した停止は判定不能に飲み込まない（スコープ付き break-glass が効く）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      breakGlass: { active: true, serviceKeys: ['stt', 'dynamic-tts'] },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('stt');
    expect(outcome.services.find((s) => s.serviceKey === 'stt')).toMatchObject({
      state: 'stopped',
      reason: 'break_glass',
    });
  });

  it('手動停止（manual_only）も確定値として残す（費用目的の停止が届かないと困る）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { mode: 'manual_only' } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('stt');
    expect(outcome.services.find((s) => s.serviceKey === 'stt')?.state).toBe('stopped');
  });

  /**
   * 🔴 段 2（override の失効判定）は捏造した TZ で行われ、「失効した」と判断されると
   * **reason から `temporary_override` が消える**（段 6 の `default_policy` に落ちる）。
   * reason だけを見ていると、TZ 次第で結論が変わることを検出できない。
   */
  it('失効判定が TZ 依存なら、reason に痕跡が無くても判定不能にする', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: {
        stt: { mode: 'manual_only', temporaryOverride: { state: 'force_running', expiresAt: '2026-07-20T09:30' } },
      },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('stt');
    expect(outcome.services.map((s) => s.serviceKey)).not.toContain('stt');
  });

  /**
   * 🔴 絶対時刻の override でも**失効していれば段 3〜6 へ落ちる**ので、結論は落ちた先の段で
   * 決まる。`expiresAt` を見た時点で「確定」と返していたため、期限付きの停止を一度でも
   * 絶対時刻で使った拠点は、**期限切れ後そのサービスが恒久的に確定扱い**になっていた
   * （自動解除は読み取り時のみで、レコードには残り続ける）。
   */
  it('失効した絶対時刻の override は、落ちた先の段で判定する', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: {
        signage: {
          mode: 'custom_schedule',
          weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
          temporaryOverride: { state: 'force_running', expiresAt: '2020-01-01T00:00:00Z' },
        },
        bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2020-01-01T00:00:00Z' } },
      },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    // 段 4（サービス個別スケジュール）と段 5（共通週間）へ落ちるので、どちらも TZ 依存。
    expect(outcome.unresolved).toContain('signage');
    expect(outcome.unresolved).toContain('bedrock');
  });

  it('expiresAt が文字列でなくても判定不能の切り分けを落とさない', async () => {
    // 型ドリフト（旧データ・部分書き込み・属性型違い）。`resolve.ts` は同じ入力を総関数として
    // 扱うのに、永続層側で throw すると Reconciler が毎分同じ例外で全サービス no-op になる。
    // 共通営業時間は**設定しない**——切り分けを通る経路でないと、この防御は踏めない。
    await getBackend()
      .collection<{ id: string }>('runtime_policy')
      .put({
        id: `${TENANT}:${SITE}`,
        tenantId: TENANT,
        siteId: SITE,
        services: { signage: { temporaryOverride: { state: 'force_stopped', expiresAt: 1234 } } },
        breakGlass: undefined,
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'legacy',
      } as unknown as { id: string });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    /*
     * 🔴 `stt`（既定 `follow_operating_hours`）で確かめると、ガードの戻り値に関わらず
     * 落ちた先が段 5 なので必ず判定不能になり、**決定を縛れない**。落ちた先が TZ 非依存な
     * `signage`（既定 `always_on`）で、確定側に出ることまで固定する。
     */
    expect(outcome.unresolved).not.toContain('signage');
    expect(outcome.services.find((s) => s.serviceKey === 'signage')?.state).toBe('running');
  });

  it('break-glass は一時 override より上の段なので、TZ が分からなくても確定する', async () => {
    // 段 1 は段 2 より先に決まるので、オフセット無しの override が同居していても影響されない。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { temporaryOverride: { state: 'force_running', expiresAt: '2026-07-20T09:30' } } },
      breakGlass: { active: true, serviceKeys: ['stt'] },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('stt');
    expect(outcome.services.find((s) => s.serviceKey === 'stt')).toMatchObject({ reason: 'break_glass' });
  });

  it('always_on + オフセット無しの force_stopped も判定不能にする', async () => {
    // 逆向き（「止めたのに確定 running と報告」）。管理画面の datetime-local は
    // オフセットを持たない値を送るので、これが既定の入力形になる。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: {
        signage: { mode: 'always_on', temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T09:30' } },
      },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('signage');
  });

  it('依存を持つサービスでも、オフセット付きの一時停止は確定値として残る', async () => {
    /*
     * 🔴 `bedrock`（`dependsOn: []`）だけで確かめていたので、閉包の分岐に到達していなかった。
     * 依存を持つ `stt` で試すと、絶対時刻の「今すぐ止める」が判定不能に吸い込まれていた
     * ——この増分の主目的そのものが、依存を持たないサービスでしか達成できていなかった。
     */
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T23:00:00Z' } } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('stt');
    expect(outcome.services.find((s) => s.serviceKey === 'stt')?.state).toBe('stopped');
  });

  it('オフセット付きの一時 override は確定値として扱う（絶対時刻なので TZ が要らない）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T23:00:00Z' } } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('bedrock');
    expect(outcome.services.find((s) => s.serviceKey === 'bedrock')?.state).toBe('stopped');
  });

  it('例外日で決まった状態も確定値として扱わない', async () => {
    // 例外日の一致判定も現地時刻。4 つの time-dependent な理由をそれぞれ固定する。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: {
        signage: {
          mode: 'custom_schedule',
          weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
          exceptionDates: [{ date: '2026-07-20', closed: true }],
        },
      },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('signage');
  });

  /**
   * 判定は書式ではなく**値**で行う。TZ の両端（UTC-12 / UTC+14）で解釈して `now` の同じ側に
   * 落ちるなら、その失効判定は TZ に依らない。境界をまたぐときだけ判定不能。
   */
  it('現地時刻の期限は、TZ の両端で結論が割れるときだけ判定不能', async () => {
    // 01:00Z 時点で、UTC-12 なら未来・UTC+14 なら過去（＝結論が割れる）。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T05:00' } } },
    });
    const straddling = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(straddling.kind).toBe('partial');
    if (straddling.kind !== 'partial') return;
    expect(straddling.unresolved).toContain('bedrock');
  });

  it('遠い過去に失効した現地時刻の期限は確定扱い（どの TZ でも失効している）', async () => {
    /*
     * 失効した override はレコードに残り続ける（自動解除は読み取り時のみ）。ここを一律
     * 判定不能にすると、期限付きの停止を一度でも使ったサービスは、共通営業時間を設定するまで
     * **Reconciler が永久に何もしない**（起動も停止も届かない）。
     */
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { signage: { temporaryOverride: { state: 'force_stopped', expiresAt: '2020-01-01T00:00' } } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).not.toContain('signage');
    expect(outcome.services.find((s) => s.serviceKey === 'signage')?.state).toBe('running');
  });

  it('解析できない期限はどの TZ でも失効扱いなので確定（型ドリフト・壊れた値）', async () => {
    // 共通営業時間は**設定しない**——設定すると早期 return で切り分けを通らず、主張が空虚になる。
    for (const expiresAt of [1234, null, '', 'garbage']) {
      await getBackend()
        .collection<{ id: string }>('runtime_policy')
        .put({
          id: `${TENANT}:${SITE}`,
          tenantId: TENANT,
          siteId: SITE,
          services: { signage: { temporaryOverride: { state: 'force_stopped', expiresAt } } },
          breakGlass: undefined,
          version: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: 'legacy',
        } as unknown as { id: string });
      const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
      expect(outcome.kind, String(expiresAt)).toBe('partial');
      if (outcome.kind !== 'partial') return;
      expect(outcome.unresolved, String(expiresAt)).not.toContain('signage');
      expect(outcome.services.find((s) => s.serviceKey === 'signage')?.state).toBe('running');
    }
  });

  it('runtime policy が未設定なら registry の既定 mode で解決する', async () => {
    await seedOperatingHours();
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(resolutionFor(outcome.resolution, 'stt')?.state).toBe('running');
    expect(resolutionFor(outcome.resolution, 'signage')?.state).toBe('running');
    expect(outcome.resolution.capabilities).toContain('speech_input');
  });

  it('保存したサービス設定が解決に効く', async () => {
    await seedOperatingHours();
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: { stt: { mode: 'manual_only' } } });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(resolutionFor(outcome.resolution, 'stt')?.state).toBe('stopped');
    // capability も落ちる（画面が「音声で話しかけてください」と出し続けないように）。
    expect(outcome.resolution.capabilities).not.toContain('speech_input');
  });

  it('break-glass が解決に効く', async () => {
    await seedOperatingHours();
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { breakGlass: { active: true } });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(resolutionFor(outcome.resolution, 'stt')?.state).toBe('stopped');
    expect(resolutionFor(outcome.resolution, 'admin')?.state).toBe('running');
  });

  /**
   * 🔴 「まだ設定していない」と「壊れている」を同じ値にしない。潰すと、壊れたレコード 1 件や
   * 継続的な DynamoDB 障害が Reconciler を**恒久的な no-op** にし、1 分ごとに静かに失敗し続ける。
   */
  it('壊れたレコードで解決が落ちても error として報告する', async () => {
    /*
     * 検証層は**新規の書き込みしか守れない**（旧スキーマ・直接編集・別経路）。解決は
     * まだ総関数ではないので、ここで潰すと壊れたレコード 1 件が Reconciler を恒久的な
     * no-op にし、1 分ごとに静かに失敗し続ける。
     */
    await seedOperatingHours();
    await getBackend()
      .collection<{ id: string }>('runtime_policy')
      .put({
        id: `${TENANT}:${SITE}`,
        tenantId: TENANT,
        siteId: SITE,
        services: { stt: { mode: 'custom_schedule', exceptionDates: 'broken' } },
        breakGlass: undefined,
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'legacy',
      } as unknown as { id: string });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
      expect(outcome.kind).toBe('error');
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  /**
   * 🔴 **壊れ方は 1 種類ではない** (#798 AC1)。
   *
   * 既存の「壊れたレコード」テストは `services.stt.exceptionDates` が非配列の形だけを見ている。
   * issue が実測で挙げている 4 つのうち、**共通営業時間側の timezone** から来る経路が
   * 抜けていた ―― `resolveRuntimeStatesFor` は `common.timezone` をそのまま `resolve` へ渡し、
   * `Intl` が知らないゾーンだと **`RangeError` で落ちる**（実測で再現済み）。
   *
   * 書き込み経路（`upsertOperatingPolicy`）は `isValidTimeZone` で塞いであるが、
   * **検証層は新規の書き込みしか守れない**。旧スキーマ・直接編集・別経路で入った値は残る。
   * ここが throw のままだと、拠点 1 つの壊れた timezone で Reconciler が毎分落ち続ける。
   */
  it('共通営業時間の timezone が壊れていても error として報告する（throw させない）', async () => {
    // 検証層を**迂回して**書く。`upsertOperatingPolicy` は弾くので直接 backend へ置く。
    await getBackend()
      .collection<{ id: string }>('operating_policy')
      .put({
        id: `${TENANT}:${SITE}`,
        tenantId: TENANT,
        siteId: SITE,
        timezone: 'Not/A/Zone',
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
        fixedHolidays: [],
        exceptionDates: [],
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'legacy',
      } as unknown as { id: string });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // 🔴 **throw しないこと自体が主張。** await が reject すればこの行で落ちる。
      const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
      expect(outcome.kind).toBe('error');
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  /**
   * 生のオフセットは #800 で**書き込めなくなった**が、それ以前のレコードは残る。
   * `Intl` は受理するので **throw しない** ―― つまり「壊れている」とは報告されず、
   * **黙って解決される**。これは #800 の AC4（`TIMEZONE_BOUNDS` の縮小）を保留している
   * 理由そのものなので、**現在の挙動を明示的に固定**しておく。
   */
  it('生オフセットの timezone は（旧レコードとして）読めて解決できる — #800 AC4 保留の根拠', async () => {
    await getBackend()
      .collection<{ id: string }>('operating_policy')
      .put({
        id: `${TENANT}:${SITE}`,
        tenantId: TENANT,
        siteId: SITE,
        timezone: '-23:59',
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
        fixedHolidays: [],
        exceptionDates: [],
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'legacy',
      } as unknown as { id: string });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    // 落ちも壊れもしない。**だから静かに残る**（TIMEZONE_BOUNDS を狭められない理由）。
    expect(outcome.kind).not.toBe('error');
  });

  it('読み取りに失敗したら error として報告し、黙って捨てない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await resolveRuntimeStatesFor('bad:tenant', SITE, IN_HOURS);
      expect(outcome.kind).toBe('error');
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
