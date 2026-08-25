/**
 * runtime policy（サービス単位の稼働ポリシー）ストアのテスト (#367)。
 *
 * 共通営業時間（`operating_policy`）とは**別コレクション**に置く。理由は保存の原子性:
 * 1 コレクションに統合すると稼働中の kiosk consumer（`kiosk-gate` / `call-guard`）を
 * 巻き込む移行が要り、両方へ書き分けると「営業時間だけ更新されてサービス設定が古い」
 * 状態を作れてしまう。合成は**読み出し時**に行う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appendAdminAudit = vi.fn();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));

import { __resetOperatingPolicyStore, upsertOperatingPolicy } from '@/lib/operating-policy/store';
import { resolutionFor } from '@/domain/runtime-policy/resolve';
import {
  __resetRuntimePolicyStore,
  getRuntimePolicy,
  resolveRuntimeStatesFor,
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
    await seedOperatingHours();
    // サービス個別の区間ゼロは恒久停止として弾かれる（共通側の値には依存しない）。
    const result = await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { stt: { mode: 'custom_schedule', weeklySchedule: {} } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.map((i) => i.field)).toContain('services.stt.weeklySchedule');
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
      const result = await upsertRuntimePolicy(TENANT, SITE, 'b@example.com', {
        expectedVersion: '1',
        services: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_input');
        expect(result.error.issues.map((i) => i.field)).toContain('expectedVersion');
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

  it('監査に時間帯の具体値を残さない（誰がどのサービスを触ったかまで）', async () => {
    await upsertRuntimePolicy(TENANT, SITE, 'admin@example.com', {
      services: { stt: { mode: 'custom_schedule', weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] } } },
    });
    expect(appendAdminAudit).toHaveBeenCalledTimes(1);
    const [action, target, metadata] = appendAdminAudit.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(action).toBe('runtime_policy.updated');
    expect(target).toMatchObject({ type: 'runtime_policy' });
    expect(metadata.serviceKeys).toBe('stt');
    expect(JSON.stringify(metadata)).not.toContain('09:00');
  });
});

describe('resolveRuntimeStatesFor', () => {
  it('共通営業時間が未設定なら undefined（判定不能を「停止」と言わない）', async () => {
    // ここで「停止」に倒すと、営業時間を未設定のまま運用を始めた拠点で受付が上がらない。
    await expect(resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS)).resolves.toBeUndefined();
  });

  it('runtime policy が未設定なら registry の既定 mode で解決する', async () => {
    await seedOperatingHours();
    const resolution = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(resolution && resolutionFor(resolution, 'stt')?.state).toBe('running');
    expect(resolution && resolutionFor(resolution, 'signage')?.state).toBe('running');
    expect(resolution?.capabilities).toContain('speech_input');
  });

  it('保存したサービス設定が解決に効く', async () => {
    await seedOperatingHours();
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { services: { stt: { mode: 'manual_only' } } });
    const resolution = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(resolution && resolutionFor(resolution, 'stt')?.state).toBe('stopped');
    // capability も落ちる（画面が「音声で話しかけてください」と出し続けないように）。
    expect(resolution?.capabilities).not.toContain('speech_input');
  });

  it('break-glass が解決に効く', async () => {
    await seedOperatingHours();
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', { breakGlass: { active: true } });
    const resolution = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(resolution && resolutionFor(resolution, 'stt')?.state).toBe('stopped');
    // 保護対象は落とさない（止めた後に戻す手段を残す）。
    expect(resolution && resolutionFor(resolution, 'admin')?.state).toBe('running');
  });
});
