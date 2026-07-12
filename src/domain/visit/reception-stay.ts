/**
 * 受付完了 → 在館記録（VisitStay）自動生成の純ロジック (issue #342)。
 *
 * 副作用・I/O を持たない。受付セッション（ReceptionSession）から在館記録を作るべきかの判定と、
 * 受付 → 在館記録作成入力（CreateStayInput）への写像を集約し node 環境で網羅検証する。
 *
 * PII 非包含（docs/checkout-stay-design.md §3、`rules/pii-secret-minimization.md`）:
 *   - 生成入力に載せるのは受付の**非 PII** 参照のみ（targetLabel / purpose / receptionId / checkedInAt）。
 *   - 氏名・会社名・メモ（visitor.*）は在館記録へ持ち込まない。来訪者識別は receptionId 参照で行う。
 */
import type { ReceptionSession } from '@/domain/reception/session';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { CreateStayInput } from './types';

/**
 * 受付完了から在館記録を自動生成すべきか。
 *
 * **担当者が応答して受付が完了した場合（connected → completed）のみ** 在館とみなす。
 * 未応答（timeout）・失敗（failed）・取消（cancelled）・代替導線経由の完了（fallback → completed、
 * callOutcome!=='connected'）では在館記録を作らない。誤った在館（実際には入館していない来訪者）を
 * 生まないための保守的な判定。
 */
export function shouldCreateStayForReception(
  session: Pick<ReceptionSession, 'state' | 'callOutcome'>,
): boolean {
  return session.state === 'completed' && session.callOutcome === 'connected';
}

/**
 * 受付セッション → 在館記録の作成入力（非 PII のみ）。
 *
 * scope（tenantId/siteId）は呼び出し側が resolveStayScope(session.kioskId) で解決して渡す
 * （kiosk セッション由来のみ。クライアント入力で scope を決めない = 越境しない）。
 * checkedInAt は受付完了時刻（completedAt）を在館起点とし、未設定なら呼び出し側の now に委ねる。
 */
export function receptionToCreateStayInput(
  session: ReceptionSession,
  scope: { tenantId: TenantId; siteId: SiteId },
): CreateStayInput {
  return {
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    // 在館起点は「受付完了（担当者応答）」の時刻。未確定なら呼び出し側の now を使う。
    checkedInAt: session.completedAt,
    // 来訪者識別は receptionId 参照のみ（氏名等 PII は載せない）。
    receptionId: session.id,
    // 非 PII の判別材料（在館一覧・退館確認ステップで使う）。
    targetLabel: session.targetLabel,
    purpose: session.purpose,
  };
}
