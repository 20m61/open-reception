import { NextResponse } from 'next/server';
import { isSecretKey } from '@/domain/security/integration-status';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  markSecretCleared,
  markSecretUpdated,
} from '@/lib/security/integration-status-store';
import { actorLabel, authorize } from '../authz';

/**
 * PUT    /api/admin/integrations/secrets — シークレットの **状態** を「更新済み」に
 *        マークする (issue #93)。
 * DELETE /api/admin/integrations/secrets — シークレットの状態を「要再設定」にマークする。
 *
 * body: { tenantId: string, key: SecretKey }
 *
 * セキュリティ最優先:
 *   - secret/private key/webhook secret の **値は受け取らない／保存しない／返さない**。
 *     値の登録自体は環境変数 / Secrets Manager 側で行い、本 API は状態だけを動かす。
 *   - レスポンス・監査・ログに平文を出さない。
 *
 * 認証: 管理セッション必須。認可: canAccessTenant(write) — tenant_admin 以上のみ。
 * 監査: secret.updated / secret.cleared を記録（key と actor のみ。値は残さない）。
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const result = await authorize(body ?? {}, 'write');
  if (!result.ok) return result.response;

  const key = body?.key;
  if (!isSecretKey(key)) {
    return NextResponse.json({ error: 'invalid_input', message: 'unknown secret key' }, { status: 400 });
  }

  const label = actorLabel(result.auth.actor);
  const status = await markSecretUpdated(key, label);
  await appendAdminAudit('secret.updated', { type: 'secret', id: key }, { actor: label });
  return NextResponse.json(status);
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const result = await authorize(body ?? {}, 'write');
  if (!result.ok) return result.response;

  const key = body?.key;
  if (!isSecretKey(key)) {
    return NextResponse.json({ error: 'invalid_input', message: 'unknown secret key' }, { status: 400 });
  }

  const label = actorLabel(result.auth.actor);
  const status = await markSecretCleared(key, label);
  await appendAdminAudit('secret.cleared', { type: 'secret', id: key }, { actor: label });
  return NextResponse.json(status);
}
