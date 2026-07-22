import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetIntegrationStatus,
  listAuthMethodStatuses,
  listIntegrationStatuses,
  listSecretStatuses,
  markSecretCleared,
  markSecretUpdated,
  recordConnectionResult,
} from './integration-status-store';
import {
  __resetProviderConfigStore,
  putTenantProviderConfig,
} from '@/lib/platform/provider-config-store';
import { __resetTenantSecretStore, getTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import { SecretValue, secretRef } from '@/domain/provider-config/secret';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

const SECRET_ENV = ['OAUTH_CLIENT_SECRET', 'WEBHOOK_SECRET', 'ADMIN_AUTH_PROVIDER'];

const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of SECRET_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  await __resetIntegrationStatus();
  __resetProviderConfigStore();
  __resetTenantSecretStore();
});

afterEach(() => {
  for (const k of SECRET_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetProviderConfigStore();
  __resetTenantSecretStore();
});

describe('integration-status-store (#93 × #405)', () => {
  it('シークレット状態は env から presence を検出し、値は含まない（VONAGE キーは対象外）', async () => {
    process.env.OAUTH_CLIENT_SECRET = 'TEST-oauth-secret-value';
    const statuses = await listSecretStatuses();
    const oauth = statuses.find((s) => s.key === 'OAUTH_CLIENT_SECRET');
    expect(oauth?.presence).toBe('configured');
    // 平文非露出: シリアライズ結果に値が一切現れない。
    expect(JSON.stringify(statuses)).not.toContain('TEST-oauth-secret-value');
    // 未設定のものは missing。
    expect(statuses.find((s) => s.key === 'WEBHOOK_SECRET')?.presence).toBe('missing');
    // VONAGE 資格情報は個別 secret キーから撤去済み（テナント設定 presence へ移行）。
    expect(statuses.some((s) => s.key.startsWith('VONAGE_'))).toBe(false);
  });

  it('markSecretUpdated は更新メタを記録するが値は受け取らない', async () => {
    const status = await markSecretUpdated('WEBHOOK_SECRET', 'tenant_admin');
    expect(status.updatedBy).toBe('tenant_admin');
    expect(status.updatedAt).toBeTruthy();
    expect(status.health).toBe('ok');
  });

  it('markSecretCleared は health=needs_rotation の状態にする', async () => {
    const status = await markSecretCleared('OAUTH_CLIENT_SECRET', 'tenant_admin');
    expect(status.health).toBe('needs_rotation');
    expect(status.presence).toBe('missing');
  });

  it('渡された presence で Vonage 連携の configured/enabled を表す', async () => {
    const configured = await listIntegrationStatuses({ configured: true, enabled: true });
    const vonage = configured.find((i) => i.id === 'vonage');
    expect(vonage?.configured).toBe(true);
    expect(vonage?.enabled).toBe(true);

    const missing = await listIntegrationStatuses({ configured: false, enabled: false });
    expect(missing.find((i) => i.id === 'vonage')?.configured).toBe(false);
  });

  it('presence 省略時は既定テナントのテナント設定 + secret から解決する', async () => {
    const tenantId = defaultTenantIdFrom();
    // テナント設定 + secret 未設定 → missing。
    let list = await listIntegrationStatuses();
    expect(list.find((i) => i.id === 'vonage')?.configured).toBe(false);

    // テナント設定（vonage/enabled）+ secret set → 設定済み・有効。
    await putTenantProviderConfig({
      tenantId,
      provider: 'vonage',
      enabled: true,
      updatedAt: '2026-07-01T00:00:00.000Z',
      updatedBy: 'platform:dev',
    });
    await getTenantSecretStore().setSecret(
      secretRef(tenantId, 'vonage'),
      new SecretValue('TEST-vonage-bundle'),
    );
    list = await listIntegrationStatuses();
    const vonage = list.find((i) => i.id === 'vonage');
    expect(vonage?.configured).toBe(true);
    expect(vonage?.enabled).toBe(true);
    // 応答に secret 値は現れない。
    expect(JSON.stringify(list)).not.toContain('TEST-vonage-bundle');
  });

  it('接続テスト結果を連携状態へ反映する', async () => {
    await recordConnectionResult('vonage', 'failure', '未設定の項目');
    let list = await listIntegrationStatuses({ configured: false, enabled: false });
    expect(list.find((i) => i.id === 'vonage')?.lastResult).toBe('failure');

    await recordConnectionResult('vonage', 'success');
    list = await listIntegrationStatuses({ configured: true, enabled: true });
    const vonage = list.find((i) => i.id === 'vonage');
    expect(vonage?.lastResult).toBe('success');
    expect(vonage?.lastErrorSummary).toBeUndefined();
  });

  it('ログイン方式の状態は機密値を含めず enabled を表す', () => {
    const methods = listAuthMethodStatuses({ ADMIN_AUTH_PROVIDER: 'none' });
    expect(methods.find((m) => m.id === 'password')?.enabled).toBe(true);
    expect(methods.find((m) => m.id === 'entra')?.enabled).toBe(false);
    // entra 選択時は設定エラーの要約のみ（機密値は含めない）。
    const entra = listAuthMethodStatuses({ ADMIN_AUTH_PROVIDER: 'entra' });
    const entraMethod = entra.find((m) => m.id === 'entra');
    expect(entraMethod?.enabled).toBe(true);
    expect(entraMethod?.issues.length).toBeGreaterThan(0);
  });
});
