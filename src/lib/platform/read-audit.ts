/**
 * platform read 系監査の記録ヘルパ (issue #83 §5 / inc5b)。
 *
 * §5 の read 系監査（対象テナント切替・テナント設定閲覧・監査ログ閲覧）を appendAuditLog へ
 * 一貫した形で渡す薄い層。write 系の recordDangerAction（@/lib/admin/audit）と同じ規約で
 *   - actor は `platform:<identity>` に帰属する（#264 説明責任）
 *   - 操作元 IP/user-agent を残す（#83 AC13 の高詳細監査と同じ取り方）
 *   - metadata は sanitize して機微値・PII を平文で残さない
 * を守る。閲覧監査のループ回避（記録するか）の判定は純関数
 * `@/domain/platform/read-audit` に置き、本ヘルパは記録だけを行う。
 */
import type { AuditAction } from '@/domain/reception/log';
import { auditContextFromRequest, sanitizeAuditMetadata } from '@/lib/admin/audit';
import { appendAuditLog } from '@/lib/data-stores/reception-log-store';

export type PlatformReadAuditInput = {
  /** read 系の AuditAction（platform.tenant_scope.switched / platform.tenant.viewed / platform.audit_log.viewed）。 */
  action: AuditAction;
  /** 操作者 identity（authorizePlatformWithIdentity の identity）。actor は platform:<identity> になる。 */
  identity: string;
  /** 対象リソース種別 / ID（PII を含めない）。 */
  target: { type: string; id?: string };
  /** 追加の補助情報。sanitize して機微値を落とす。 */
  metadata?: Record<string, unknown>;
  /** 操作元の IP・user-agent を記録するためのリクエスト。 */
  request?: Request;
};

/** read 系監査を記録する。失敗は握り潰さず伝播させる（未監査の read を返さない・fail-closed）。 */
export async function recordPlatformReadAudit(input: PlatformReadAuditInput) {
  const ctx = input.request ? auditContextFromRequest(input.request) : {};
  return appendAuditLog({
    action: input.action,
    actor: `platform:${input.identity}`,
    targetType: input.target.type,
    targetId: input.target.id,
    metadata: sanitizeAuditMetadata(input.metadata),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
