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
import { randomUUID } from 'node:crypto';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import { checkOut } from '@/domain/visit/state';
import { asStayId, type CreateStayInput, type StayId, type VisitStay } from '@/domain/visit/types';
import type { StayRepository } from './repository';
import { DEFAULT_RETENTION_DAYS } from './service';

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

/**
 * kiosk 起票の監査追記関数（PII なし。token/code/氏名は載せない）。
 * store.ts が appendAuditLog を注入する。テストでは差し替え可能。
 */
export type KioskAuditAppend = (entry: {
  action: AuditAction;
  actor: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, string>;
}) => Promise<unknown>;

export type KioskStayServiceDeps = {
  repo: StayRepository;
  now?: () => Date;
  /** 起票監査（stay.updated）。未注入なら監査を行わない（テスト簡略化用）。 */
  appendAudit?: KioskAuditAppend;
};

/** 受付完了からの在館記録自動生成の入力（kioskId は監査帰属に使う。#342）。 */
export type CreatePresentForReceptionInput = {
  scope: { tenantId: TenantId; siteId: SiteId };
  stay: CreateStayInput;
  /** 監査 actor の帰属先（`kiosk:<id>`）。scope 解決に使った kiosk セッション id。 */
  kioskId: string;
};

export class KioskStayService {
  private readonly repo: StayRepository;
  private readonly now: () => Date;
  private readonly appendAudit?: KioskAuditAppend;

  constructor(deps: KioskStayServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
    this.appendAudit = deps.appendAudit;
  }

  /**
   * 受付完了時に在館記録（present）を自動生成する (issue #342)。
   *
   * 管理 actor を介さない **kiosk セーフな起票**。scope は resolveStayScope(kioskId) 由来で
   * 二重防御（repository の境界フィルタ）。retention/監査は管理経由の createPresent と揃える
   * （DEFAULT_RETENTION_DAYS・stay.updated）。PII は保存も監査もしない。
   *
   * **冪等**: 同一 receptionId の在館記録が同 scope に既にあれば再生成せず既存 id を返す
   * （受付完了画面の再マウント/再試行で在館記録が二重化しないため）。
   *
   * 監査失敗は在館記録の生成を妨げない（best-effort。監査に PII は無い）。
   */
  async createPresentForReception(input: CreatePresentForReceptionInput): Promise<StayId> {
    const { scope, stay: create, kioskId } = input;

    // 冪等: 既存の同一 receptionId 在館記録があれば再利用する（二重生成防止）。
    if (create.receptionId) {
      const existing = (await this.repo.listPresent(scope.tenantId, scope.siteId)).find(
        (s) => s.receptionId === create.receptionId,
      );
      if (existing) return existing.id;
    }

    const nowIso = this.now().toISOString();
    const stay: VisitStay = {
      id: asStayId(`stay-${randomUUID()}`),
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      status: 'present',
      checkedInAt: create.checkedInAt ?? nowIso,
      reservationId: create.reservationId,
      receptionId: create.receptionId,
      targetLabel: create.targetLabel,
      purpose: create.purpose,
      retentionDays: create.retentionDays ?? DEFAULT_RETENTION_DAYS,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const created = await this.repo.create(stay);
    // 生成失敗（id 衝突は randomUUID ゆえ実質起きない）は例外に委ね、route が 503 で握る。
    if (!created.ok) throw new Error(`failed to create stay: ${created.error.message}`);

    // 起票監査（PII なし。状態のみ）。失敗しても在館記録の生成は妨げない。
    if (this.appendAudit) {
      try {
        await this.appendAudit({
          action: 'stay.updated',
          actor: `kiosk:${kioskId}`,
          targetType: 'stay',
          targetId: stay.id,
          metadata: { status: stay.status },
        });
      } catch {
        // 監査追記の失敗は在館記録の生成を無効化しない（帰属ログの欠落のみ）。
      }
    }

    return stay.id;
  }

  /**
   * 当該サイトの在館中（present）滞在を返す（#274 ①: 受付端末の在館一覧）。
   * 走査・status フィルタの詳細は repository に閉じる（route は collection を知らない）。
   */
  async listPresent(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]> {
    return this.repo.listPresent(tenantId, siteId);
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
