/**
 * 招待モデル（発行主体 / 受付対象 / 接続先の分離）の単体テスト (issue #375)。
 *
 * 固定するのは 4 つ:
 *   - 現行の 1 参照（`targetType` + `targetId`）から**情報を失わずに**写せること
 *   - 発行者・受付対象・接続先が**別の ID 空間**であることを型が守っていること
 *   - MVP 制約「発行担当者本人へ接続される」が機械的に判定できること
 *   - 将来の拡張（代理発行・部署 QR・Endpoint 直指し・取次ルート）で既存の写しが壊れないこと
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
  connectionTargetOf,
  invitationFromReservation,
  isSelfConnectedInvitation,
  legacyConnectionTargetOf,
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
    companyName: 'TEST-株式会社',
    note: 'TEST-メモ',
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

const issuerSato: InvitationIssuer = { actorType: 'staff', staffId: 'staff-sato' };

describe('現行モデルからの写し', () => {
  it('担当者宛の予約は staff 参照になる', () => {
    expect(receptionTargetOf(reservation())).toEqual({ type: 'staff', staffId: 'staff-sato' });
  });

  it('部署宛の予約は organization 参照になる（#373 の組織モデルに合わせる）', () => {
    const r = reservation({ targetType: 'department', targetId: 'dept-sales' });
    expect(receptionTargetOf(r)).toEqual({ type: 'organization', organizationId: 'dept-sales' });
  });

  it('接続先は「その所有者の取次に委ねる」形で写す（MVP は本人の取次）', () => {
    // 現行レコードは具体的な Endpoint を持たないので、決め打ちで endpoint を作らない。
    expect(connectionTargetOf(reservation())).toEqual({
      type: 'owner',
      ownerType: 'staff',
      ownerId: 'staff-sato',
    });
  });

  it('発行者は予約レコードに無いので、呼び出し側が渡す', () => {
    expect(invitationFromReservation(reservation(), issuerSato).issuedBy).toEqual(issuerSato);
  });

  it('移行対象の旧レコードは発行者不明として明示する（system 自動発行と区別する）', () => {
    // 「発行者 = 受付対象」と推測して埋めると、代理発行が入った瞬間に嘘の監査情報になる。
    // かつ「不明」と「システム自動発行」は別物なので、同じ値に潰さない。
    const inv = invitationFromReservation(reservation());
    expect(inv.issuedBy).toEqual(ISSUER_UNKNOWN);
    expect(inv.issuedBy.actorType).toBe('unknown');
  });

  it('レコード全体を欠落なく写す（移行で情報が落ちない）', () => {
    const inv = invitationFromReservation(reservation(), issuerSato);
    // キー集合を網羅で固定する。除外リスト方式だと、PII フィールドが**足された**ときに落ちない。
    expect(Object.keys(inv).sort()).toEqual(
      [
        'connectionTarget',
        'expiresAt',
        'id',
        'issuedBy',
        'receptionTarget',
        'siteId',
        'status',
        'tenantId',
        'usagePolicy',
        'visitAt',
      ].sort(),
    );
    // テナント境界は第一級の不変条件なので、値まで固定する。
    expect(inv.tenantId).toBe(reservation().tenantId);
    expect(inv.siteId).toBe(reservation().siteId);
    expect(inv.id).toBe(reservation().id);
    expect(inv.visitAt).toBe(reservation().visitAt);
    expect(inv.expiresAt).toBe(reservation().expiresAt);
    expect(inv.usagePolicy).toBe(reservation().usagePolicy);
    expect(inv.status).toBe(reservation().status);
  });

  it('PII と照合キーを持ち込まない', () => {
    // 上のキー網羅で構造的には担保済みだが、意図を名指しで残す（何を防いでいるかが読める）。
    const inv = invitationFromReservation(reservation(), issuerSato);
    for (const key of ['visitorName', 'companyName', 'note', 'token', 'tokenHash']) {
      expect(inv, key).not.toHaveProperty(key);
    }
  });
});

describe('現行モデルへの逆写し', () => {
  it('受付対象は必ず往復して元に戻る（表現できない値を型で作れない）', () => {
    for (const targetType of ['staff', 'department'] as ReservationTargetType[]) {
      const r = reservation({ targetType, targetId: `id-${targetType}` });
      expect(legacyTargetOf(receptionTargetOf(r))).toEqual({
        targetType,
        targetId: `id-${targetType}`,
      });
    }
  });

  it('所有者に委ねる接続先は現行モデルへ戻せる', () => {
    const back = legacyConnectionTargetOf(connectionTargetOf(reservation()));
    expect(back).toEqual({ ok: true, targetType: 'staff', targetId: 'staff-sato' });
  });

  it('Endpoint 直指し・取次ルートは現行モデルで表現できない（黙って丸めない）', () => {
    // 1 参照モデルの限界そのもの。staff へ丸めるとルートの順次取次が直通に変わる。
    // 失敗を `ok:false` で返すので、spread しても握り潰しに気づける（null だと消える）。
    expect(legacyConnectionTargetOf({ type: 'endpoint', endpointId: 'ep-1' })).toEqual({
      ok: false,
      reason: 'endpoint',
    });
    expect(legacyConnectionTargetOf({ type: 'route', routingPolicyId: 'rp-1' })).toEqual({
      ok: false,
      reason: 'route',
    });
  });
});

describe('MVP 制約「発行担当者本人へ接続される」', () => {
  it('発行者・受付対象・接続先がすべて同一担当者なら満たす', () => {
    expect(isSelfConnectedInvitation(invitationFromReservation(reservation(), issuerSato))).toBe(
      true,
    );
  });

  it('代理発行（発行者が別の担当者）は満たさない', () => {
    const inv = invitationFromReservation(reservation(), {
      actorType: 'staff',
      staffId: 'staff-suzuki',
    });
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });

  it('管理者による代理発行は満たさない（ID 空間が違うので突き合わせない）', () => {
    // 運用者 identity は email / subject（`lib/auth/actor.ts`）で、担当者ディレクトリ ID とは
    // 別空間。型で分けてあるので「たまたま文字列が一致したら本人」も起こらない。
    const inv = invitationFromReservation(reservation(), {
      actorType: 'admin',
      identity: 'staff-sato',
    });
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });

  it('接続先が受付対象と違う担当者なら満たさない（部署 QR で当番者へ繋ぐ形）', () => {
    const inv = {
      ...invitationFromReservation(reservation(), issuerSato),
      connectionTarget: { type: 'owner', ownerType: 'staff', ownerId: 'staff-suzuki' } as const,
    };
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });

  it('接続先が Endpoint 直指し・取次ルートなら満たさない', () => {
    const base = invitationFromReservation(reservation(), issuerSato);
    expect(
      isSelfConnectedInvitation({
        ...base,
        connectionTarget: { type: 'endpoint', endpointId: 'ep-1' },
      }),
    ).toBe(false);
    expect(
      isSelfConnectedInvitation({
        ...base,
        connectionTarget: { type: 'route', routingPolicyId: 'rp-1' },
      }),
    ).toBe(false);
  });

  it('発行者不明の移行レコードは満たさない（不明を「本人」に読み替えない）', () => {
    expect(isSelfConnectedInvitation(invitationFromReservation(reservation()))).toBe(false);
  });

  it('部署宛は本人接続ではない（担当者以外は MVP 制約の対象外）', () => {
    const r = reservation({ targetType: 'department', targetId: 'dept-sales' });
    const inv = invitationFromReservation(r, { actorType: 'staff', staffId: 'dept-sales' });
    expect(isSelfConnectedInvitation(inv)).toBe(false);
  });
});
