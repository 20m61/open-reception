/**
 * QR チェックイン service (issue #98, increment 1)。
 *
 * 受付端末が QR から予約を解決し、確認後にチェックイン（使用済み化）するための薄い層。
 * #97 の repository / lifecycle 純関数を **import 利用のみ**（編集しない）。
 *
 * 重要な設計（docs/qr-checkin-design.md §3）:
 *   - resolve は閲覧のみ。予約サマリ（最小限）を返し、状態は変えない（期限切れの
 *     永続反映を除く）。即時呼び出し・使用済み化はしない。
 *   - confirm（markUsed）は来訪者の確認操作後にのみ呼ぶ（single_use の 1 回利用）。
 *   - 失敗理由（expired / used / revoked / invalid / not_found）を区別して返す。
 *   - 通信断（リポジトリ例外）は呼び出し側（route）が networkError として扱う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { isUsableAt, markExpiredIfNeeded, markUsed } from '@/domain/reservation/lifecycle';
import type { VisitReservation } from '@/domain/reservation/types';
import { hashReservationToken } from '@/domain/reservation/token';
import type { ReservationRepository } from '@/lib/reservation/repository';
import type {
  CheckinFailureReason,
  CheckinSummary,
  ResolveResult,
} from '@/domain/checkin/types';
import { extractReservationToken } from './payload';

export type CheckinServiceDeps = {
  repo: ReservationRepository;
  now?: () => Date;
  /**
   * token hash の pepper（server secret・#375）。発行側（ReservationService）と同一値でなければ
   * 照合が一致しない。省略時は pepper なし。
   */
  pepper?: string;
};

/** 予約から確認画面用の最小限サマリを作る（token / note / id を含めない）。 */
function toSummary(r: VisitReservation): CheckinSummary {
  return {
    visitorName: r.visitorName,
    companyName: r.companyName,
    visitAt: r.visitAt,
    targetType: r.targetType,
    targetId: r.targetId,
    usagePolicy: r.usagePolicy,
  };
}

/** 利用不可の予約から失敗理由を導く（区別が要件）。 */
function reasonFor(r: VisitReservation, now: Date): CheckinFailureReason {
  switch (r.status) {
    case 'used':
      return 'used';
    case 'revoked':
      return 'revoked';
    case 'cancelled':
      // キャンセル済みは「該当予約として案内しない」= not_found 相当で扱う。
      return 'not_found';
    case 'expired':
      return 'expired';
    case 'active':
      // active でも利用不可 = 期限切れ or same_day 窓外。どちらも expired として案内する。
      return 'expired';
    default:
      return 'not_found';
  }
}

export class CheckinService {
  private readonly repo: ReservationRepository;
  private readonly now: () => Date;
  private readonly pepper: string;

  constructor(deps: CheckinServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
    this.pepper = deps.pepper ?? '';
  }

  /**
   * QR payload（URL or 生 token）から予約サマリを解決する。**使用済み化しない**。
   * 利用可能なら summary、不可なら理由を返す。期限切れは状態へ永続反映する。
   */
  async resolve(tenantId: TenantId, siteId: SiteId, rawPayload: string): Promise<ResolveResult> {
    const token = extractReservationToken(rawPayload);
    if (!token) return { ok: false, reason: 'invalid' };

    // 生 token は hash してから照合する（保存は hash のみ・#375）。
    const found = await this.repo.findByTokenHash(
      tenantId,
      siteId,
      hashReservationToken(token, this.pepper),
    );
    if (!found) return { ok: false, reason: 'not_found' };

    const now = this.now();
    // 期限切れを参照時に永続反映（active のままにしない）。
    const expired = markExpiredIfNeeded(found, now);
    const current = expired.ok ? expired.value : found;
    if (expired.ok && current.status !== found.status) {
      await this.repo.put(current);
    }

    if (isUsableAt(current, now)) return { ok: true, summary: toSummary(current) };
    return { ok: false, reason: reasonFor(current, now) };
  }

  /**
   * 確認後のチェックイン: single_use の予約を使用済みにする（markUsed）。
   * resolve と同様に token で引き、利用可能なときのみ used へ遷移して保存する。
   * same_day は markUsed しても受付窓内なら再利用可だが、監査・受付接続の起点として呼ぶ。
   *
   * 戻り値は使用済み化後の summary（確認済みの呼び出し先解決に使う）か失敗理由。
   */
  async confirm(tenantId: TenantId, siteId: SiteId, rawPayload: string): Promise<ResolveResult> {
    const token = extractReservationToken(rawPayload);
    if (!token) return { ok: false, reason: 'invalid' };

    // 生 token は hash してから照合する（保存は hash のみ・#375）。
    const found = await this.repo.findByTokenHash(
      tenantId,
      siteId,
      hashReservationToken(token, this.pepper),
    );
    if (!found) return { ok: false, reason: 'not_found' };

    const now = this.now();
    const used = markUsed(found, now);
    if (!used.ok) {
      // 利用不可（期限切れ / 使用済み / 失効 / 窓外）。期限切れは反映してから理由を返す。
      const expired = markExpiredIfNeeded(found, now);
      if (expired.ok && expired.value.status !== found.status) await this.repo.put(expired.value);
      const current = expired.ok ? expired.value : found;
      return { ok: false, reason: reasonFor(current, now) };
    }

    await this.repo.put(used.value);
    return { ok: true, summary: toSummary(used.value) };
  }
}
