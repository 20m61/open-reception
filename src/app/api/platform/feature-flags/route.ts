import { NextResponse } from 'next/server';
import { isVonageConfigured, isVonageEnabled } from '@/lib/call/vonage-config';
import { listAuthMethodStatuses } from '@/lib/security/integration-status-store';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/feature-flags — 機能フラグ / 利用制限の read (issue #90, increment 2)。
 *
 * developer 専用の read-only API。本増分では「取得可能な範囲」を実接続し、未接続項目は
 * status:'pending' で明示する（偽の安心を与えない）。
 *
 * 実接続（プラットフォーム全体の現状）:
 *   - Vonage 電話通知（configured / enabled を env から判定。機密値は含めない）。
 *   - 管理画面ログイン方式（Entra ID / Google(Cognito) / 共有パスワード）の有効状態。
 *
 * 未接続（次増分でテナント単位の値として接続）:
 *   - 音声合成・VRM/アバター受付のフラグ、受付端末上限・月間通話数上限・概算コスト上限。
 *
 * 変更（フラグ切り替え・上限変更）は破壊的操作のため本 API では提供せず、画面側で
 * DangerActionPlaceholder に隔離する（次増分で昇格・理由入力・確認・監査を伴う）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const authMethods = listAuthMethodStatuses();
  const pending = { status: 'pending' as const };

  return NextResponse.json({
    // プラットフォーム全体で接続済みのフラグ。テナント単位の上書きは次増分。
    flags: {
      vonage: { configured: isVonageConfigured(), enabled: isVonageEnabled() },
      authMethods,
      voiceSynthesis: pending,
      avatarReception: pending,
    },
    // 利用上限はメータリング（#89）未接続のため pending。
    limits: {
      receptionDevices: pending,
      monthlyCalls: pending,
      estimatedCost: pending,
    },
  });
}
