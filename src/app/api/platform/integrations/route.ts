import { NextResponse } from 'next/server';
import {
  listIntegrationStatuses,
  listAuthMethodStatuses,
} from '@/lib/security/integration-status-store';
import {
  toIntegrationStatusRows,
  toAuthMethodStatusRows,
} from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/integrations — 外部連携状態の read (issue #90, increment 3 / #83)。
 *
 * developer 専用の read-only API。Vonage などの外部連携と、管理画面ログイン方式
 * （Entra / Cognito / 共有パスワード）の「登録状態・有効状態・接続結果・最終日時」のみを
 * 横断確認する。**API シークレット・秘密鍵などの機密値は一切含めない**（#83 機密非露出方針）。
 *
 * 射影は純関数（console-summary の toIntegrationStatusRows / toAuthMethodStatusRows）へ委譲し、
 * 表示に必要なフィールドのみを whitelist する。シークレット再登録・連携設定変更は破壊的操作の
 * ため本 API では提供せず、画面側で確認・昇格・監査を伴う導線へ隔離する（次増分）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const integrations = toIntegrationStatusRows(await listIntegrationStatuses());
  const authMethods = toAuthMethodStatusRows(listAuthMethodStatuses());

  return NextResponse.json({ integrations, authMethods });
}
