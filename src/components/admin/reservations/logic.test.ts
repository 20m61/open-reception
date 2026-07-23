import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationTokenHash,
  type ReservationStatus,
  type VisitReservation,
} from '@/domain/reservation/types';
import {
  availableActions,
  qrFileName,
  sortByVisitAt,
  statusKind,
  statusLabel,
  summarize,
  targetTypeLabel,
  usagePolicyLabel,
} from './logic';

function fixture(overrides: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('default'),
    visitorName: '来訪 太郎',
    visitAt: '2026-07-01T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: asReservationTokenHash('hash'),
    usagePolicy: 'single_use',
    expiresAt: '2026-07-08T01:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const ALL_STATUSES: ReservationStatus[] = ['active', 'used', 'expired', 'revoked', 'cancelled'];

describe('status mapping (#97)', () => {
  it('全ステータスに StatusKind とラベルが定義されている', () => {
    for (const s of ALL_STATUSES) {
      expect(statusKind(s)).toBeTruthy();
      expect(statusLabel(s)).toBeTruthy();
    }
  });

  it('有効は ok、失効は critical に写す', () => {
    expect(statusKind('active')).toBe('ok');
    expect(statusKind('revoked')).toBe('critical');
  });
});

describe('label helpers (#97)', () => {
  it('利用制約・呼び出し先種別を日本語にする', () => {
    expect(usagePolicyLabel('single_use')).toBe('1 回利用');
    expect(usagePolicyLabel('same_day')).toBe('当日内利用');
    expect(targetTypeLabel('staff')).toBe('担当者');
    expect(targetTypeLabel('department')).toBe('部署');
  });
});

describe('availableActions (#97)', () => {
  it('active は編集/キャンセル/失効/再発行ができる(#375: QR 紛失時の復旧手段として再発行を許す)', () => {
    const a = availableActions('active');
    expect(a).toMatchObject({ canEdit: true, canCancel: true, canRevoke: true, canReissue: true });
  });

  it('expired/revoked は再発行でき、編集/キャンセル/失効は不可', () => {
    for (const s of ['expired', 'revoked'] as ReservationStatus[]) {
      const a = availableActions(s);
      expect(a.canReissue).toBe(true);
      expect(a.canEdit).toBe(false);
      expect(a.canCancel).toBe(false);
      expect(a.canRevoke).toBe(false);
    }
  });

  it('used/cancelled は再発行も含めすべて不可（QR 表示のみ可）', () => {
    for (const s of ['used', 'cancelled'] as ReservationStatus[]) {
      const a = availableActions(s);
      expect(a.canReissue).toBe(false);
      expect(a.canEdit).toBe(false);
    }
  });

  it('QR 表示はどの状態でも可能', () => {
    for (const s of ALL_STATUSES) expect(availableActions(s).canShowQr).toBe(true);
  });
});

describe('summarize (#97)', () => {
  it('ステータス別に件数を集計し total を合算する', () => {
    const summary = summarize([
      fixture({ status: 'active' }),
      fixture({ status: 'active' }),
      fixture({ status: 'used' }),
      fixture({ status: 'revoked' }),
    ]);
    expect(summary.active).toBe(2);
    expect(summary.used).toBe(1);
    expect(summary.revoked).toBe(1);
    expect(summary.expired).toBe(0);
    expect(summary.total).toBe(4);
  });

  it('空配列はすべて 0', () => {
    const summary = summarize([]);
    expect(summary.total).toBe(0);
    for (const s of ALL_STATUSES) expect(summary[s]).toBe(0);
  });
});

describe('sortByVisitAt (#97)', () => {
  it('予定日時の昇順に並べ替える（元配列は変更しない）', () => {
    const input = [
      fixture({ id: asReservationId('b'), visitAt: '2026-07-03T00:00:00.000Z' }),
      fixture({ id: asReservationId('a'), visitAt: '2026-07-01T00:00:00.000Z' }),
      fixture({ id: asReservationId('c'), visitAt: '2026-07-02T00:00:00.000Z' }),
    ];
    const sorted = sortByVisitAt(input);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'c', 'b']);
    // 非破壊。
    expect(input.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('qrFileName (#97)', () => {
  it('id を含むファイル名を作り、危険文字を除去する', () => {
    expect(qrFileName('rsv-abc_123')).toBe('reservation-qr-rsv-abc_123.svg');
    expect(qrFileName('../../etc/passwd')).toBe('reservation-qr-etcpasswd.svg');
  });
});
