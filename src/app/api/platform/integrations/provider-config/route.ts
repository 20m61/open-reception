import { NextResponse } from 'next/server';
import { authorizePlatform, authorizePlatformWithIdentity } from '@/lib/platform/request';
import { resolveProviderConfigContext } from '@/lib/platform/provider-config-access';
import { getTenantProviderConfig, putTenantProviderConfig } from '@/lib/platform/provider-config-store';
import { getTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import { secretRef } from '@/domain/provider-config/secret';
import { buildTenantProviderConfig } from '@/domain/provider-config/config';
import { toProviderConfigView } from '@/domain/provider-config/types';
import { providerConfigWarnings } from '@/domain/provider-config/readiness';
import { recordDangerAction } from '@/lib/admin/audit';

/**
 * テナント別 CCaaS プロバイダ設定の read / 非秘密設定 upsert (issue #405 Inc1)。
 *
 * developer 専用（authorizePlatform に一点集約）。対象 tenantId は選択中テナント Cookie を実在
 * テナントへ解決した**認可済みコンテキスト**から導出し、body/query の tenantId は使わない（AC4）。
 *
 * 応答は非秘密設定 + secret presence（set|missing）のみ。secret の値・操作者識別子は返さない（AC1）。
 */

/** GET: 選択中テナントのプロバイダ設定 + secret presence を返す（read）。 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;
  const ctx = await resolveProviderConfigContext(auth.actor);
  if (!ctx.ok) return ctx.response;

  const config = await getTenantProviderConfig(ctx.tenantId);
  if (!config) {
    return NextResponse.json({ config: null, secretPresence: 'missing', warnings: [] });
  }
  const has = await getTenantSecretStore().hasSecret(secretRef(ctx.tenantId, config.provider));
  const presence = has ? 'set' : 'missing';
  // 読み取り側にも載せる。保存直後だけ出す形にすると、画面を開き直した運用者には
  // 「未接続」としか見えず、受付が 503 になっている理由に辿り着けない（#763）。
  return NextResponse.json({
    config: toProviderConfigView(config, presence),
    warnings: providerConfigWarnings(config, presence),
  });
}

/**
 * PUT: 非秘密設定を upsert する。secret 風キーは build 段で拒否する（設定ストアへ secret を入れない, AC2）。
 * 監査は integration.updated（tenantId/provider/enabled と before/after のみ・値なし）。
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;
  const ctx = await resolveProviderConfigContext(auth.actor);
  if (!ctx.ok) return ctx.response;

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const built = buildTenantProviderConfig(body, {
    tenantId: ctx.tenantId, // 認可済みコンテキスト由来のみ（body.tenantId は無視, AC4）。
    now: new Date(),
    updatedBy: `platform:${auth.identity}`,
  });
  if (!built.ok) {
    return NextResponse.json({ error: 'invalid_input', message: built.error }, { status: 400 });
  }

  const prev = await getTenantProviderConfig(ctx.tenantId);
  await putTenantProviderConfig(built.value);

  await recordDangerAction({
    action: 'integration.updated',
    target: { type: 'tenant_provider_config', id: `${ctx.tenantId}/${built.value.provider}` },
    metadata: { tenantId: ctx.tenantId, provider: built.value.provider, enabled: built.value.enabled },
    before: prev ? { provider: prev.provider, enabled: prev.enabled } : undefined,
    after: { provider: built.value.provider, enabled: built.value.enabled },
    actor: `platform:${auth.identity}`,
    request,
  });

  const has = await getTenantSecretStore().hasSecret(secretRef(ctx.tenantId, built.value.provider));
  const presence = has ? 'set' : 'missing';
  // 🔴 **保存は拒否しない**（2026-08-21 のユーザー判断）。「設定を先に保存 →
  // secret を後で入れる」という二段階の運用導線を壊さないため。代わりに警告を返し、
  // 「有効にした瞬間から受付が 503 になる」ことを保存した本人へその場で伝える。
  return NextResponse.json({
    config: toProviderConfigView(built.value, presence),
    warnings: providerConfigWarnings(built.value, presence),
  });
}
