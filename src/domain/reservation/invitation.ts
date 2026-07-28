/**
 * 招待モデル: 発行主体 / 受付対象 / 接続先の分離 (issue #375)。
 *
 * **なぜ 3 つに分けるか**: 現行の予約は「呼び出し先」を `targetType` + `targetId` の
 * **1 参照**でしか持たない。この 1 参照は実際には 3 つの異なる問いに同時に答えている:
 *
 *   1. 誰がこの QR を発行したか（発行主体）
 *   2. 誰を訪ねる受付か（受付対象）
 *   3. 最初にどこへ接続するか（接続先）
 *
 * MVP は「担当者本人が発行し、本人が受付対象で、本人へ接続する」ため 3 つが同じ値になり、
 * 1 参照でも成立している。だが代理発行（秘書が発行）・部署 QR（受付対象は部署、接続先は
 * 当番者）・イベント QR（接続先は取次ルート）が入った瞬間に 3 つは別物になる。
 *
 * **3 者は ID 空間も違う**。運用者 identity は email / subject（`lib/auth/actor.ts`）、担当者は
 * ディレクトリ ID（`domain/staff/types.ts` の `Staff.id`）、接続先は Endpoint / ルートの ID
 * （`domain/routing/`）。素の `string` で並べると「たまたま一致したら本人」になりうるので、
 * **判別可能ユニオンでフィールド名ごと分ける**（`organization/types.ts` が同じ理由で採った形）。
 *
 * **接続先の語彙は #374 に合わせる。** `domain/routing/endpoint.ts` は既に「受付対象（誰を呼ぶか）」と
 * 「実際の接続先（どこへ繋ぐか）」の分離を担っており、ここで並行した語彙を作らない
 * （第 42 wave の初版は独自の共用型を作っており、レビューで #374 との重複を指摘されて改めた）。
 *
 * **この増分は純ロジックのみ**（`VisitReservation` の永続形は変えない）。予約の永続化は
 * まだ in-memory のみで DynamoDB 実装が無く、`targetType` / `targetId` は管理 API の公開形
 * でもあるため、置き換えは別増分（公開 API を動かすため要ユーザー確認）。同じ進め方の先例が
 * `./migration.ts`（token hash 化）で、永続化増分が入る前に移行経路をテストで固定してある。
 *
 * PII も照合キー（`tokenHash`）も持ち込まない。氏名・会社名・メモ・hash は予約本体から読む。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  ReservationId,
  ReservationStatus,
  ReservationTargetType,
  ReservationUsagePolicy,
  VisitReservation,
} from './types';

/**
 * 発行主体。**ID 空間ごとにフィールドを分ける**判別可能ユニオン。
 *
 * - `staff`   … 担当者本人が発行した（MVP）。`staffId` は担当者ディレクトリの ID。
 * - `admin`   … 管理者が代理発行した。`identity` は監査帰属キー（email / subject）で、
 *               担当者ディレクトリ ID とは**別空間**。両者を突き合わせてはいけない。
 * - `system`  … システムが自動発行した（ID を持たない）。
 * - `unknown` … **発行者が記録されていない**（#375 以前の移行対象レコード）。
 *
 * `system` と `unknown` を同じ値に潰さないこと。「自動発行された」と「誰が出したか分からない」は
 * 監査上まったく別の意味で、潰すと移行済みレコードと区別できなくなる。
 */
export type InvitationIssuer =
  | { readonly actorType: 'staff'; readonly staffId: string }
  | { readonly actorType: 'admin'; readonly identity: string }
  | { readonly actorType: 'system' }
  | { readonly actorType: 'unknown' };

/**
 * 発行者不明（移行対象レコード）。**「不明」を明示する値**であって既定値ではない。
 *
 * `actorId` フィールドを構造的に持たないので、うっかり ID として読まれることも、
 * 共有シングルトンを書き換えて全レコードの監査帰属を汚染することも起きない。
 * 参照同一性には依存しないこと（JSON 往復で `=== ISSUER_UNKNOWN` は壊れる）。
 */
export const ISSUER_UNKNOWN: InvitationIssuer = Object.freeze({ actorType: 'unknown' });

/** 発行者が記録されていないか。参照ではなく値で判定する。 */
export function isIssuerUnknown(issuer: InvitationIssuer): boolean {
  return issuer.actorType === 'unknown';
}

/**
 * 受付対象: **誰を訪ねる受付か**。
 *
 * 取次ルートは含めない（「取次ルートを訪ねる受付」は意味を成さない）。表現できない値を
 * 型で作れなくしてあるので、現行モデルへの逆写しは常に成功する。
 */
export type ReceptionTargetRef =
  | { readonly type: 'staff'; readonly staffId: string }
  | { readonly type: 'organization'; readonly organizationId: string };

/**
 * 接続先: **最初にどこへ繋ぐか**。#374（`domain/routing/`）の語彙に対応させる。
 *
 * - `owner`    … その所有者の取次に委ねる（MVP。具体的な Endpoint は実行時に解決する）。
 * - `endpoint` … `ContactEndpoint` を直指しする（`domain/routing/endpoint.ts`）。
 * - `route`    … `RoutingPolicy` に委ねる（`domain/routing/policy.ts`）。
 *
 * 現行レコードは具体的な Endpoint を持たないので、移行では必ず `owner` になる
 * （決め打ちで Endpoint を作らない＝存在しない接続先を捏造しない）。
 */
export type ConnectionTargetRef =
  | { readonly type: 'owner'; readonly ownerType: 'staff' | 'organization'; readonly ownerId: string }
  | { readonly type: 'endpoint'; readonly endpointId: string }
  | { readonly type: 'route'; readonly routingPolicyId: string };

/**
 * 招待（分離後のモデル）。`VisitReservation` から PII と照合キーを落とし、1 参照を
 * 3 参照へ展開した形。**受付・取次の判断に必要な情報だけ**を持つ。
 *
 * `tokenHash` は照合キーであって判断の入力ではないので持たない（`id` で予約本体を引く）。
 * 持たせると `api/admin/reservations/tokenhash-leak-guard.test.ts` の手動列挙の**外側**に
 * hash を持つ新しい形が生まれ、漏洩ガードの網が実質的に緩む。
 */
export type ReceptionInvitation = {
  id: ReservationId;
  tenantId: TenantId;
  siteId: SiteId;
  issuedBy: InvitationIssuer;
  receptionTarget: ReceptionTargetRef;
  connectionTarget: ConnectionTargetRef;
  visitAt: string;
  usagePolicy: ReservationUsagePolicy;
  expiresAt: string;
  status: ReservationStatus;
};

/** 未知の値が黙って既定へ丸まらないようにする（受付で「別人を呼ぶ」を防ぐ）。 */
function assertNever(value: never): never {
  throw new Error(`unhandled reservation target type: ${String(value)}`);
}

/** 現行の 1 参照 → 受付対象。 */
export function receptionTargetOf(reservation: VisitReservation): ReceptionTargetRef {
  switch (reservation.targetType) {
    case 'staff':
      return { type: 'staff', staffId: reservation.targetId };
    case 'department':
      return { type: 'organization', organizationId: reservation.targetId };
    default:
      return assertNever(reservation.targetType);
  }
}

/**
 * 現行の 1 参照 → 接続先。MVP は「受付対象の所有者の取次に委ねる」。
 * 具体的な Endpoint は現行レコードに無いので作らない。
 */
export function connectionTargetOf(reservation: VisitReservation): ConnectionTargetRef {
  const target = receptionTargetOf(reservation);
  return target.type === 'staff'
    ? { type: 'owner', ownerType: 'staff', ownerId: target.staffId }
    : { type: 'owner', ownerType: 'organization', ownerId: target.organizationId };
}

/** 受付対象 → 現行の 1 参照。表現できない値が型に無いので**常に成功する**。 */
export function legacyTargetOf(ref: ReceptionTargetRef): {
  targetType: ReservationTargetType;
  targetId: string;
} {
  switch (ref.type) {
    case 'staff':
      return { targetType: 'staff', targetId: ref.staffId };
    case 'organization':
      return { targetType: 'department', targetId: ref.organizationId };
    default:
      return assertNever(ref);
  }
}

/**
 * 接続先 → 現行の 1 参照。**Endpoint 直指し・取次ルートは表現できない。**
 *
 * `null` ではなく Result で返す。`null` は spread（`{...legacyConnectionTargetOf(ref)}`）で
 * 静かに消えて `targetType` / `targetId` ごと欠落するが、`ok:false` なら残るので握り潰しに
 * 気づける。ここで `staff` へ丸めると、ルートの順次取次が単一担当者への直通に変わる。
 */
export function legacyConnectionTargetOf(
  ref: ConnectionTargetRef,
):
  | { ok: true; targetType: ReservationTargetType; targetId: string }
  | { ok: false; reason: 'endpoint' | 'route' } {
  switch (ref.type) {
    case 'owner':
      return {
        ok: true,
        targetType: ref.ownerType === 'organization' ? 'department' : 'staff',
        targetId: ref.ownerId,
      };
    case 'endpoint':
      return { ok: false, reason: 'endpoint' };
    case 'route':
      return { ok: false, reason: 'route' };
    default:
      return assertNever(ref);
  }
}

/**
 * 現行の予約レコードから招待を作る（移行マッピング）。
 *
 * `issuedBy` は**予約レコードに存在しない**ため呼び出し側が渡す。省略時は `ISSUER_UNKNOWN`
 * （移行前レコード）。運用者が発行した場合、呼び出し側は identity を担当者ディレクトリ ID へ
 * 解決してから `actorType: 'staff'` で渡すこと（解決せず `admin` で渡すと本人接続にならない）。
 */
export function invitationFromReservation(
  reservation: VisitReservation,
  issuedBy: InvitationIssuer = ISSUER_UNKNOWN,
): ReceptionInvitation {
  return {
    id: reservation.id,
    tenantId: reservation.tenantId,
    siteId: reservation.siteId,
    issuedBy,
    receptionTarget: receptionTargetOf(reservation),
    connectionTarget: connectionTargetOf(reservation),
    visitAt: reservation.visitAt,
    usagePolicy: reservation.usagePolicy,
    expiresAt: reservation.expiresAt,
    status: reservation.status,
  };
}

/**
 * MVP 制約「発行担当者本人へ接続される」を満たすか (issue #375 受け入れ条件)。
 *
 * 3 者すべてが**同一の担当者**を指すときだけ true。部署宛・Endpoint 直指し・取次ルート宛や、
 * 発行者不明の移行レコードは false（不明を「本人」に読み替えない）。管理者発行も false
 * （`identity` は担当者ディレクトリ ID と別空間なので、そもそも突き合わせない）。
 *
 * **判定するだけで強制はしない。** false のときに受付をどう扱うか（取次へ回すか、
 * 有人支援へ落とすか）は、この述語を呼ぶ増分で体験設計と併せて決める。
 */
export function isSelfConnectedInvitation(invitation: ReceptionInvitation): boolean {
  const { issuedBy, receptionTarget, connectionTarget } = invitation;
  if (issuedBy.actorType !== 'staff') return false;
  if (receptionTarget.type !== 'staff') return false;
  if (connectionTarget.type !== 'owner' || connectionTarget.ownerType !== 'staff') return false;
  return issuedBy.staffId === receptionTarget.staffId && receptionTarget.staffId === connectionTarget.ownerId;
}
