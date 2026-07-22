import { NextResponse } from 'next/server';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { resolveProviderConfigContext } from '@/lib/platform/provider-config-access';
import { getTenantProviderConfig } from '@/lib/platform/provider-config-store';
import { getTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import { SecretValue, secretRef } from '@/domain/provider-config/secret';
import { recordDangerAction } from '@/lib/admin/audit';

/**
 * テナント別プロバイダ secret の write-only 設定 / 消去 (issue #405 Inc1)。
 *
 * developer 専用。対象 tenantId は認可済みコンテキスト（選択中テナント Cookie の実在解決）から導出し、
 * body の tenantId は使わない（AC4）。secret の値は**応答にも監査にも一切載せない**（AC1）。set/clear は
 * 対象プロバイダのアクティブ設定に対して行い、**期待 provider 名の一致**を確認フィールドで要求して誤操作を防ぐ（AC6）。
 */

/** PUT: secret を write-only で設定する。応答は presence のみ（値・echo なし）。監査は secret.updated。 */
export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;
  const ctx = await resolveProviderConfigContext(auth.actor);
  if (!ctx.ok) return ctx.response;

  const config = await getTenantProviderConfig(ctx.tenantId);
  if (!config) {
    return NextResponse.json({ error: 'config_required' }, { status: 409 });
  }

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  // 上書き誤操作防止: 期待 provider 名の一致を要求（AC6）。
  if (body.expectedProvider !== config.provider) {
    return NextResponse.json({ error: 'confirmation_mismatch' }, { status: 409 });
  }

  const rawSecret = body.secret;
  if (typeof rawSecret !== 'string' || rawSecret.trim() === '') {
    // secret の値は echo しない（静的メッセージ, AC1）。
    return NextResponse.json({ error: 'invalid_input', message: 'secret required' }, { status: 400 });
  }

  await getTenantSecretStore().setSecret(
    secretRef(ctx.tenantId, config.provider),
    new SecretValue(rawSecret),
  );

  await recordDangerAction({
    action: 'secret.updated',
    target: { type: 'tenant_provider_secret', id: `${ctx.tenantId}/${config.provider}` },
    metadata: { tenantId: ctx.tenantId, provider: config.provider, result: 'set' },
    actor: `platform:${auth.identity}`,
    request,
  });

  return NextResponse.json({ secretPresence: 'set' });
}

/** DELETE: secret を消去する。応答は presence のみ。監査は secret.cleared。確認フィールドで誤操作防止。 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;
  const ctx = await resolveProviderConfigContext(auth.actor);
  if (!ctx.ok) return ctx.response;

  const config = await getTenantProviderConfig(ctx.tenantId);
  if (!config) {
    return NextResponse.json({ error: 'config_required' }, { status: 409 });
  }

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (body.expectedProvider !== config.provider) {
    return NextResponse.json({ error: 'confirmation_mismatch' }, { status: 409 });
  }

  await getTenantSecretStore().clearSecret(secretRef(ctx.tenantId, config.provider));

  await recordDangerAction({
    action: 'secret.cleared',
    target: { type: 'tenant_provider_secret', id: `${ctx.tenantId}/${config.provider}` },
    metadata: { tenantId: ctx.tenantId, provider: config.provider, result: 'cleared' },
    actor: `platform:${auth.identity}`,
    request,
  });

  return NextResponse.json({ secretPresence: 'missing' });
}
