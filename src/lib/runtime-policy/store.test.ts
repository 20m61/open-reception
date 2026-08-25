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
import { resolutionFor } from '@/domain/runtime-policy/resolve';
import { getBackend } from '@/lib/data';
import {
  __resetRuntimePolicyStore,
  getRuntimePolicy,
  resolveRuntimeStatesFor,
  runtimePolicyKey,
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

  it('一時 override も確定値として扱わない（期限の解釈に timezone が要る）', async () => {
    // `expiresAt` にオフセットが無い値は現地時刻として読むので、TZ が分からないと
    // 「まだ有効か」を決められない。効いているように見せて実は数時間ずれる方が危ない。
    await upsertRuntimePolicy(TENANT, SITE, 'a@example.com', {
      services: { bedrock: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-20T23:00' } } },
    });
    const outcome = await resolveRuntimeStatesFor(TENANT, SITE, IN_HOURS);
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.unresolved).toContain('bedrock');
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
