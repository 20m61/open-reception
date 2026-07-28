/**
 * 招待モデル: 発行主体 / 受付対象 / 接続先の分離 (issue #375)。
 *
 * **なぜ 3 つに分けるか**: 現行の予約は「呼び出し先」を `targetType` + `targetId` の
 * **1 参照**でしか持たない。この 1 参照は実際には 3 つの異なる問いに同時に答えてしまっている:
 *
 *   1. 誰がこの QR を発行したか（発行主体）
 *   2. 誰を訪ねる受付か（受付対象）
 *   3. 最初にどこへ接続するか（接続先）
 *
 * MVP は「担当者本人が発行し、本人が受付対象で、本人へ接続する」ため 3 つが同じ値になり、
 * 1 参照でも成立している。だが代理発行（秘書が発行）・部署 QR（受付対象は部署、接続先は
 * 当番者）・イベント QR（接続先は取次ルート）が入った瞬間に 3 つは別物になる。**同一で
 * あることに依存したコードを書かない**のが本モジュールの目的。
 *
 * **この増分は純ロジックのみ**（`VisitReservation` の永続形は変えない）。予約の永続化は
 * まだ in-memory のみで DynamoDB 実装が無く、`targetType` / `targetId` は管理 API の公開形
 * でもあるため、置き換えは別増分（公開 API を動かすため要ユーザー確認）。同じ進め方の先例が
 * `./migration.ts`（token hash 化）で、永続化増分が入る前に移行経路をテストで固定してある。
 *
 * PII は持ち込まない。氏名・会社名・メモは受付・取次の実行時に予約本体から読む。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  ReservationId,
  ReservationStatus,
  ReservationTargetType,
  ReservationTokenHash,
  ReservationUsagePolicy,
  VisitReservation,
} from './types';

/**
 * 発行主体の種別。
 * - `staff`  … 担当者本人が発行した（MVP）。
 * - `admin`  … 管理者が代理発行した。
 * - `system` … 自動発行、または**発行者が記録されていない**（移行前レコード）。
 */
export type InvitationActorType = 'staff' | 'admin' | 'system';

export type InvitationIssuer = {
  actorType: InvitationActorType;
  actorId: string;
};

/**
 * 移行前（#375 以前）のレコードの発行者。**「不明」を明示する値**であって、既定値ではない。
 *
 * ここを「発行者 = 受付対象」と推測して埋めてはいけない。MVP では実際に一致するが、
 * 代理発行が入った瞬間に**嘘の監査情報**になり、しかも移行済みレコードと区別できなくなる。
 */
export const ISSUER_UNKNOWN: InvitationIssuer = { actorType: 'system', actorId: '' };

/**
 * 受付対象 / 接続先の参照。
 * - `staff`        … 担当者個人。
 * - `organization` … 部署・組織単位（現行の `department` はここへ写す。#373 の組織モデル）。
 * - `route`        … 取次ルート（#374 の `RoutingPolicy`）。**現行の 1 参照では表現できない**。
 */
export type ReceptionTargetRefType = 'staff' | 'organization' | 'route';

export type ReceptionTargetRef = {
  type: ReceptionTargetRefType;
  id: string;
};

/**
 * 招待（分離後のモデル）。`VisitReservation` から PII を落とし、1 参照を 3 参照へ展開した形。
 * 受付・取次の判断に必要な情報だけを持つ。
 */
export type ReceptionInvitation = {
  id: ReservationId;
  tenantId: TenantId;
  siteId: SiteId;
  tokenHash: ReservationTokenHash;
  issuedBy: InvitationIssuer;
  receptionTarget: ReceptionTargetRef;
  connectionTarget: ReceptionTargetRef;
  visitAt: string;
  usagePolicy: ReservationUsagePolicy;
  expiresAt: string;
  status: ReservationStatus;
};

/** 現行の 1 参照 → 受付対象の参照。 */
export function receptionTargetOf(reservation: VisitReservation): ReceptionTargetRef {
  return {
    type: reservation.targetType === 'department' ? 'organization' : 'staff',
    id: reservation.targetId,
  };
}

/**
 * 受付対象の参照 → 現行の 1 参照。**取次ルートは表現できないので `null` を返す。**
 *
 * ここで `route` を `staff` へ丸めると、接続先の意味が静かに変わる（ルートの順次取次が
 * 単一担当者への直通になる）。表現できないことを呼び出し側へ返して、判断させる。
 */
export function legacyTargetOf(
  ref: ReceptionTargetRef,
): { targetType: ReservationTargetType; targetId: string } | null {
  if (ref.type === 'route') return null;
  return {
    targetType: ref.type === 'organization' ? 'department' : 'staff',
    targetId: ref.id,
  };
}

/**
 * 現行の予約レコードから招待を作る（移行マッピング）。
 *
 * `issuedBy` は**予約レコードに存在しない**ため呼び出し側が渡す。省略時は `ISSUER_UNKNOWN`
 * （移行前レコード）。受付対象と接続先は MVP では同じ値になるが、**別オブジェクトとして**
 * 作る（片方だけを将来変えたときに、もう片方が道連れで動かないようにする）。
 */
export function invitationFromReservation(
  reservation: VisitReservation,
  issuedBy: InvitationIssuer = ISSUER_UNKNOWN,
): ReceptionInvitation {
  const target = receptionTargetOf(reservation);
  return {
    id: reservation.id,
    tenantId: reservation.tenantId,
    siteId: reservation.siteId,
    tokenHash: reservation.tokenHash,
    issuedBy,
    receptionTarget: { ...target },
    connectionTarget: { ...target },
    visitAt: reservation.visitAt,
    usagePolicy: reservation.usagePolicy,
    expiresAt: reservation.expiresAt,
    status: reservation.status,
  };
}

/**
 * MVP 制約「発行担当者本人へ接続される」を満たすか (issue #375 受け入れ条件)。
 *
 * 3 者すべてが**同一の担当者**を指すときだけ true。部署・取次ルート宛や、発行者不明の
 * 移行レコードは false になる（不明を「本人」に読み替えない）。
 */
export function isSelfConnectedInvitation(invitation: ReceptionInvitation): boolean {
  const { issuedBy, receptionTarget, connectionTarget } = invitation;
  if (issuedBy.actorType !== 'staff') return false;
  if (receptionTarget.type !== 'staff' || connectionTarget.type !== 'staff') return false;
  return issuedBy.actorId === receptionTarget.id && receptionTarget.id === connectionTarget.id;
}
