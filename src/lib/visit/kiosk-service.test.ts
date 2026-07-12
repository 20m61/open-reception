import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId, type CreateStayInput, type VisitStay } from '@/domain/visit/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedStayRepository } from './repository';
import { KioskStayService, parseStayId, type KioskAuditAppend } from './kiosk-service';

// #274 ①: memory repository は廃止。memory backend + seed で単一実装を直接検証する（§9.2）。
afterEach(() => {
  __resetBackend();
});

const T = asTenantId('dev-tenant');
const S = asSiteId('dev-site');
const OTHER = asSiteId('other-site');
const NOW = new Date('2026-06-20T10:00:00.000Z');

function stay(over: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: T,
    siteId: S,
    status: 'present',
    checkedInAt: '2026-06-20T09:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: '2026-06-20T09:00:00.000Z',
    ...over,
  };
}

function makeService(seed: VisitStay[] = []) {
  __resetBackend();
  const repo = new DataBackedStayRepository(() => seed.map((s) => ({ ...s })));
  return { repo, service: new KioskStayService({ repo, now: () => NOW }) };
}

describe('KioskStayService.checkOutById (issue #102)', () => {
  it('受付番号で退館を確定し、PII を含まないレシートを返す', async () => {
    const { service, repo } = makeService([stay()]);
    const r = await service.checkOutById(T, S, 'stay-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.receipt).toEqual({ stayId: 'stay-1', checkedOutAt: NOW.toISOString() });
      const keys = Object.keys(r.receipt);
      expect(keys).not.toContain('visitorName');
      expect(keys).not.toContain('reservationId');
    }
    expect((await repo.get(T, S, asStayId('stay-1')))?.status).toBe('checked_out');
  });

  it('二重退館を防ぐ（2 度目は already_checked_out）', async () => {
    const { service } = makeService([stay()]);
    expect((await service.checkOutById(T, S, 'stay-1')).ok).toBe(true);
    expect(await service.checkOutById(T, S, 'stay-1')).toEqual({
      ok: false,
      reason: 'already_checked_out',
    });
  });

  it('該当なしは not_found', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, S, 'nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('空入力は invalid', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, S, '   ')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('越境スコープでは退館できない（二重防御・not_found）', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, OTHER, 'stay-1')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('KioskStayService.createPresentForReception (issue #342)', () => {
  const baseInput = (over: Partial<CreateStayInput> = {}): CreateStayInput => ({
    tenantId: T,
    siteId: S,
    checkedInAt: '2026-06-20T09:30:00.000Z',
    receptionId: 'rec-1',
    targetLabel: '営業部 佐藤',
    purpose: 'meeting',
    ...over,
  });

  function makeCreator(seed: VisitStay[] = [], audit?: KioskAuditAppend) {
    __resetBackend();
    const repo = new DataBackedStayRepository(() => seed.map((s) => ({ ...s })));
    return { repo, service: new KioskStayService({ repo, now: () => NOW, appendAudit: audit }) };
  }

  it('present の在館記録を scope 内に起票し、非 PII フィールドのみ持つ', async () => {
    const { service, repo } = makeCreator();
    const stayId = await service.createPresentForReception({
      scope: { tenantId: T, siteId: S },
      stay: baseInput(),
      kioskId: 'kiosk-9',
    });
    const saved = await repo.get(T, S, asStayId(stayId));
    expect(saved).toBeDefined();
    expect(saved?.status).toBe('present');
    expect(saved?.tenantId).toBe(T);
    expect(saved?.siteId).toBe(S);
    expect(saved?.receptionId).toBe('rec-1');
    expect(saved?.targetLabel).toBe('営業部 佐藤');
    expect(saved?.purpose).toBe('meeting');
    expect(saved?.checkedInAt).toBe('2026-06-20T09:30:00.000Z');
    // retention は既定を再利用（新方式を発明しない）。
    expect(saved?.retentionDays).toBe(30);
    // PII を持たない。
    expect(saved).not.toHaveProperty('visitor');
    expect(JSON.stringify(saved)).not.toContain('山田');
  });

  it('checkedInAt 未指定なら now を在館起点にする', async () => {
    const { service, repo } = makeCreator();
    const stayId = await service.createPresentForReception({
      scope: { tenantId: T, siteId: S },
      stay: baseInput({ checkedInAt: undefined }),
      kioskId: 'kiosk-9',
    });
    const saved = await repo.get(T, S, asStayId(stayId));
    expect(saved?.checkedInAt).toBe(NOW.toISOString());
  });

  it('冪等: 同一 receptionId は再生成せず既存 id を返す（二重起票しない）', async () => {
    const { service, repo } = makeCreator();
    const scope = { tenantId: T, siteId: S };
    const first = await service.createPresentForReception({ scope, stay: baseInput(), kioskId: 'k' });
    const second = await service.createPresentForReception({ scope, stay: baseInput(), kioskId: 'k' });
    expect(second).toBe(first);
    const present = await repo.listPresent(T, S);
    expect(present).toHaveLength(1);
  });

  it('起票を stay.updated として kiosk 帰属で監査する（PII なし）', async () => {
    const audit = vi.fn<KioskAuditAppend>().mockResolvedValue(undefined);
    const { service } = makeCreator([], audit);
    const stayId = await service.createPresentForReception({
      scope: { tenantId: T, siteId: S },
      stay: baseInput(),
      kioskId: 'kiosk-9',
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]![0];
    expect(entry.action).toBe('stay.updated');
    expect(entry.actor).toBe('kiosk:kiosk-9');
    expect(entry.targetType).toBe('stay');
    expect(entry.targetId).toBe(stayId);
    expect(entry.metadata).toEqual({ status: 'present' });
    // 監査に PII/氏名/token を載せない。
    expect(JSON.stringify(entry)).not.toContain('山田');
  });

  it('監査失敗は在館記録の生成を妨げない（best-effort）', async () => {
    const audit = vi.fn<KioskAuditAppend>().mockRejectedValue(new Error('audit backend down'));
    const { service, repo } = makeCreator([], audit);
    const stayId = await service.createPresentForReception({
      scope: { tenantId: T, siteId: S },
      stay: baseInput(),
      kioskId: 'k',
    });
    expect((await repo.get(T, S, asStayId(stayId)))?.status).toBe('present');
  });

  it('scope は渡された値（kiosk セッション由来）を使い、越境しない', async () => {
    // 別サイトの scope を渡すと別サイトに起票され、元サイトからは参照できない（境界フィルタ）。
    const { service, repo } = makeCreator();
    const stayId = await service.createPresentForReception({
      scope: { tenantId: T, siteId: OTHER },
      stay: baseInput({ siteId: OTHER }),
      kioskId: 'k',
    });
    expect(await repo.get(T, S, asStayId(stayId))).toBeUndefined();
    expect((await repo.get(T, OTHER, asStayId(stayId)))?.siteId).toBe(OTHER);
  });
});

describe('parseStayId (issue #102)', () => {
  it('空白を除去し、空・非文字列は null', () => {
    expect(parseStayId(' stay-1 ')).toBe('stay-1');
    expect(parseStayId('')).toBeNull();
    expect(parseStayId(undefined)).toBeNull();
    expect(parseStayId(42)).toBeNull();
  });
});
