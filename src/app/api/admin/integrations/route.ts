import { NextResponse } from 'next/server';
import {
  listAuthMethodStatuses,
  listIntegrationStatuses,
  listSecretStatuses,
} from '@/lib/security/integration-status-store';
import { authorize } from './authz';

/**
 * GET /api/admin/integrations?tenantId= — 認証方式・外部連携・シークレットの
 * **状態**を取得する (issue #93)。
 *
 * セキュリティ: secret / private key / webhook secret の値は一切返さない。
 * 返すのは「設定済みか」「最終更新日時/更新者」「接続結果」などの状態のみ。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 canAccessTenant(read) — 当該テナントの閲覧権（viewer 以上）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const result = await authorize(new URL(request.url).searchParams, 'read');
  if (!result.ok) return result.response;

  const [secrets, integrations] = await Promise.all([
    listSecretStatuses(),
    listIntegrationStatuses(),
  ]);
  return NextResponse.json({
    authMethods: listAuthMethodStatuses(),
    integrations,
    secrets,
  });
}
