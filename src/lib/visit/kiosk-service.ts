/**
 * 受付端末（kiosk）向けの退館サービス (issue #102, increment 1)。
 *
 * 管理 actor を介さず、kiosk セッションで保護された退館確定を扱う薄い層。
 * テナント/サイト境界は repository のフィルタ（resolveStayScope で解決した scope）で
 * 二重防御する。状態遷移は純関数（src/domain/visit/state.ts）へ委譲する。
 *
 * 退館後は PII を返さない。返すのは滞在 id・状態・退館時刻のみ
 * （docs/checkout-stay-design.md §3）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { checkOut } from '@/domain/visit/state';
import { asStayId, type StayId, type VisitStay } from '@/domain/visit/types';
import type { StayRepository } from './repository';

/** 退館の失敗理由。受付端末が文言を出し分ける。 */
export type CheckoutFailureReason = 'not_found' | 'already_checked_out' | 'invalid';

/** 退館完了レシート（PII を含めない）。 */
export type CheckoutReceipt = {
  stayId: StayId;
  checkedOutAt: string;
};

export type KioskCheckoutResult =
  | { ok: true; receipt: CheckoutReceipt }
  | { ok: false; reason: CheckoutFailureReason };

export type KioskStayServiceDeps = {
  repo: StayRepository;
  now?: () => Date;
};

export class KioskStayService {
  private readonly repo: StayRepository;
  private readonly now: () => Date;

  constructor(deps: KioskStayServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 受付番号（stayId）から退館を確定する。
   * - 該当なし / 越境: not_found（端末から越境理由を見せない）。
   * - 終端（退館済み / 取消）: already_checked_out（二重退館防止・誤操作からの復帰）。
   */
  async checkOutById(
    tenantId: TenantId,
    siteId: SiteId,
    rawStayId: string,
  ): Promise<KioskCheckoutResult> {
    const id = parseStayId(rawStayId);
    if (!id) return { ok: false, reason: 'invalid' };

    const found = await this.repo.get(tenantId, siteId, id);
    if (!found) return { ok: false, reason: 'not_found' };

    const result = checkOut(found, this.now());
    if (!result.ok) return { ok: false, reason: 'already_checked_out' };

    await this.repo.put(result.value);
    return { ok: true, receipt: toReceipt(result.value) };
  }
}

function toReceipt(stay: VisitStay): CheckoutReceipt {
  return { stayId: stay.id, checkedOutAt: stay.checkedOutAt ?? stay.updatedAt };
}

/** 受付番号文字列を StayId へ正規化する。空・非文字列は null。 */
export function parseStayId(raw: unknown): StayId | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return asStayId(trimmed);
}
