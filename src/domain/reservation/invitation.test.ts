/**
 * 招待モデル（発行主体 / 受付対象 / 接続先の分離）の単体テスト (issue #375)。
 *
 * 固定するのは 3 つ:
 *   - 現行の 1 参照（`targetType` + `targetId`）から 3 参照へ**情報を失わずに**写せること
 *   - MVP 制約「発行担当者本人へ接続される」が**機械的に判定できる**こと
 *   - 将来の拡張（代理発行・部署 QR・取次ルート）を入れても既存の写しが壊れないこと
 */
import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationTokenHash,
  type ReservationTargetType,
  type VisitReservation,
} from './types';
import {
  ISSUER_UNKNOWN,
  invitationFromReservation,
  isSelfConnectedInvitation,
  legacyTargetOf,
  receptionTargetOf,
  type InvitationIssuer,
} from './invitation';

function reservation(overrides: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('r1'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('default-site'),
    visitorName: 'TEST-来訪者',
    visitAt: '2026-08-01T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-sato',
    tokenHash: asReservationTokenHash('0'.repeat(64)),
    usagePolicy: 'single_use',
    expiresAt: '2026-08-01T09:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('現行モデルからの写し', () => {
  it('担当者宛の予約は staff 参照になる', () => {
    expect(receptionTargetOf(reservation())).toEqual({ type: 'staff', id: 'staff-sato' });
  });

  it('部署宛の予約は organization 参照になる（#373 の組織モデルに合わせる）', () => {
    const r = reservation({ targetType: 'department', targetId: 'dept-sales' });
    expect(receptionTargetOf(r)).toEqual({ type: 'organization', id: 'dept-sales' });
  });

  it('受付対象と接続先を別々に持つ（MVP は同一値だが、同一であることに依存しない）', () => {
    const inv = invitationFromReservation(reservation(), {
      actorType: 'staff',
      actorId: 'staff-sato',
    });
    expect(inv.receptionTarget).toEqual({ type: 'staff', id: 'staff-sato' });
    expect(inv.connectionTarget).toEqual({ type: 'staff', id: 'staff-sato' });
    // 同一オブジェクトを共有していない（片方を将来変えたときにもう片方が動かない）。
    expect(inv.receptionTarget).not.toBe(inv.connectionTarget);
  });

  it('発行者は予約レコードに無いので、呼び出し側が渡す', () => {
    const issuer: InvitationIssuer = { actorType: 'admin', actorId: 'admin-1' };
    expect(invitationFromReservation(reservation(), issuer).issuedBy).toEqual(issuer);
  });

  it('移行対象の旧レコードは発行者不明として明示する（担当者と取り違えない）', () => {
    // 「発行者 = 受付対象」と推測して埋めると、代理発行が入った瞬間に嘘の監査情報になる。
    const inv = invitationFromReservation(reservation());
    expect(inv.issuedBy).toEqual(ISSUER_UNKNOWN);
    expect(inv.issuedBy.actorType).toBe('system');
  });

  it('PII と token 生値を持ち込まない', () => {
    const inv = invitationFromReservation(
      reservation({ note: 'TEST-メモ', companyName: 'TEST-株式会社' }),
    );
    expect(inv).not.toHaveProperty('note');
    expect(inv).not.toHaveProperty('token');
    expect(inv.tokenHash).toBe(reservation().tokenHash);
  });
});

describe('現行モデルへの逆写し（往復で壊れない）', () => {
  it('staff / department は往復して元に戻る', () => {
    for (const targetType of ['staff', 'department'] as ReservationTargetType[]) {
      const r = reservation({ targetType, targetId: `id-${targetType}` });
      const ref = receptionTargetOf(r);
      expect(legacyTargetOf(ref)).toEqual({ targetType, targetId: `id-${targetType}` });
    }
  });

  it('取次ルート宛は現行モデルで表現できない（null を返し、黙って捨てない）', () => {
    // ここが 1 参照モデルの限界で、分離が要る理由そのもの。誤って staff へ丸めない。
    expect(legacyTargetOf({ type: 'route', id: 'route-1' })).toBeNull();
  });
});

describe('MVP 制約「発行担当者本人へ接続される」', () => {
  it('発行者・受付対象・接続先がすべて同一担当者なら満たす', () => {
    const inv = invitationFromReservation(reservation(), {
      actorType: 'staff',
      actorId: 'staff-sato',
    });
    expect(isSelfConnectedInvitation(inv)).toBe(true);
  });

  it('代理発行（発行者が別人）は満たさない', () => {
    const inv = invitationFromReservation(reservation(), {
      actorType: 'staff',
      actorId: 'staff-suzuki',
    });
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });

  it('接続先が受付対象と違えば満たさない', () => {
    const inv = {
      ...invitationFromReservation(reservation(), { actorType: 'staff', actorId: 'staff-sato' }),
      connectionTarget: { type: 'route', id: 'route-1' } as const,
    };
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });

  it('発行者不明の移行レコードは満たさない（不明を「本人」に読み替えない）', () => {
    expect(isSelfConnectedInvitation(invitationFromReservation(reservation()))).toBe(false);
  });

  it('部署宛は本人接続ではない（担当者以外は MVP 制約の対象外）', () => {
    const r = reservation({ targetType: 'department', targetId: 'dept-sales' });
    const inv = invitationFromReservation(r, { actorType: 'staff', actorId: 'dept-sales' });
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });
});
