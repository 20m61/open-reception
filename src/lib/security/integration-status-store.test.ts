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

const SECRET_ENV = [
  'VONAGE_APPLICATION_ID',
  'VONAGE_API_KEY',
  'VONAGE_API_SECRET',
  'VONAGE_PRIVATE_KEY',
  'OAUTH_CLIENT_SECRET',
  'WEBHOOK_SECRET',
  'VONAGE_ENABLED',
  'ADMIN_AUTH_PROVIDER',
];

const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of SECRET_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  await __resetIntegrationStatus();
});

afterEach(() => {
  for (const k of SECRET_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('integration-status-store (#93)', () => {
  it('シークレット状態は env から presence を検出し、値は含まない', async () => {
    process.env.VONAGE_API_SECRET = 'real-secret-value';
    const statuses = await listSecretStatuses();
    const apiSecret = statuses.find((s) => s.key === 'VONAGE_API_SECRET');
    expect(apiSecret?.presence).toBe('configured');
    // 平文非露出: シリアライズ結果に値が一切現れない。
    expect(JSON.stringify(statuses)).not.toContain('real-secret-value');
    // 未設定のものは missing。
    expect(statuses.find((s) => s.key === 'WEBHOOK_SECRET')?.presence).toBe('missing');
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

  it('接続テスト結果を連携状態へ反映する', async () => {
    await recordConnectionResult('vonage', 'failure', '未設定の項目: VONAGE_API_SECRET');
    let list = await listIntegrationStatuses();
    expect(list.find((i) => i.id === 'vonage')?.lastResult).toBe('failure');

    await recordConnectionResult('vonage', 'success');
    list = await listIntegrationStatuses();
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
