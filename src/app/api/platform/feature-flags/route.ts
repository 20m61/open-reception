import { NextResponse } from 'next/server';
import { isVonageConfigured, isVonageEnabled } from '@/lib/call/vonage-config';
import { listAuthMethodStatuses } from '@/lib/security/integration-status-store';
import { authorizePlatform } from '@/lib/platform/request';
import {
  DEFAULT_TENANT_FEATURE_FLAGS,
  TENANT_FEATURE_FLAG_KEYS,
  effectiveTenantFeatureFlags,
  type TenantFeatureFlagKey,
} from '@/domain/platform/feature-flags';
import { listTenantFeatureFlagRecords } from '@/lib/platform/feature-flag-store';

/**
 * GET /api/platform/feature-flags — 機能フラグ / 利用制限の read (issue #90 inc2 / #83 inc5a)。
 *
 * developer 専用の read-only API。「取得可能な範囲」を実接続し、未接続項目は
 * status:'pending' で明示する（偽の安心を与えない）。
 *
 * 実接続（プラットフォーム全体の現状）:
 *   - Vonage 電話通知（configured / enabled を env から判定。機密値は含めない）。
 *   - 管理画面ログイン方式（Entra ID / Google(Cognito) / 共有パスワード）の有効状態。
 *   - テナント別機能フラグ（音声合成・VRM/アバター受付）のサマリ（既定値 + 無効化テナント数, #83 inc5a）。
 *     テナント単位の実効値と変更は /api/platform/tenants/[tenantId]/feature-flags（変更は JIT 昇格必須）。
 *
 * 未接続（後続増分でメータリング #89 と接続）:
 *   - 受付端末上限・月間通話数上限・概算コスト上限。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const authMethods = listAuthMethodStatuses();
  const pending = { status: 'pending' as const };

  // テナント別フラグのサマリ: 既定値と、既定から無効へ上書きされたテナント数（#83 inc5a）。
  const records = await listTenantFeatureFlagRecords();
  const tenantFlagSummary = {} as Record<
    TenantFeatureFlagKey,
    { defaultEnabled: boolean; disabledTenants: number }
  >;
  for (const key of TENANT_FEATURE_FLAG_KEYS) {
    tenantFlagSummary[key] = {
      defaultEnabled: DEFAULT_TENANT_FEATURE_FLAGS[key],
      disabledTenants: records.filter((r) => !effectiveTenantFeatureFlags(r)[key]).length,
    };
  }

  return NextResponse.json({
    flags: {
      vonage: { configured: isVonageConfigured(), enabled: isVonageEnabled() },
      authMethods,
      ...tenantFlagSummary,
    },
    // 利用上限はメータリング（#89）未接続のため pending。
    limits: {
      receptionDevices: pending,
      monthlyCalls: pending,
      estimatedCost: pending,
    },
  });
}
