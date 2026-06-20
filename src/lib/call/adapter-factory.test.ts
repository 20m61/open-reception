import { afterEach, describe, expect, it } from 'vitest';
import { getCallAdapter } from './adapter-factory';
import { isVonageConfigured, isVonageEnabled } from './vonage-config';
import { MockCallAdapter } from '@/adapters/call/mock';
import { VonageCallAdapter } from '@/adapters/call/vonage';
import { MOCK_STAFF } from '@/domain/staff/mock-data';

const VONAGE_KEYS = ['VONAGE_APPLICATION_ID', 'VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_PRIVATE_KEY', 'VONAGE_ENABLED'];

function clearVonageEnv() {
  for (const k of VONAGE_KEYS) delete process.env[k];
}

afterEach(clearVonageEnv);

describe('call adapter selection (#4)', () => {
  it('既定（未設定）では Mock を使う', () => {
    clearVonageEnv();
    expect(getCallAdapter(MOCK_STAFF)).toBeInstanceOf(MockCallAdapter);
  });

  it('設定済みでも VONAGE_ENABLED でなければ Mock を使う', () => {
    clearVonageEnv();
    process.env.VONAGE_APPLICATION_ID = 'a';
    process.env.VONAGE_API_KEY = 'b';
    process.env.VONAGE_API_SECRET = 'c';
    process.env.VONAGE_PRIVATE_KEY = 'd';
    expect(isVonageConfigured()).toBe(true);
    expect(isVonageEnabled()).toBe(false);
    expect(getCallAdapter(MOCK_STAFF)).toBeInstanceOf(MockCallAdapter);
  });

  it('明示的に有効化され設定済みなら Vonage adapter を使う', () => {
    clearVonageEnv();
    process.env.VONAGE_ENABLED = 'true';
    process.env.VONAGE_APPLICATION_ID = 'a';
    process.env.VONAGE_API_KEY = 'b';
    process.env.VONAGE_API_SECRET = 'c';
    process.env.VONAGE_PRIVATE_KEY = 'd';
    expect(getCallAdapter(MOCK_STAFF)).toBeInstanceOf(VonageCallAdapter);
  });
});

describe('VonageCallAdapter (#4)', () => {
  // session 作成が失敗しても受付フローを壊さず failed を返す。
  // 実ネットワークを呼ばないよう stub service を注入する（詳細は vonage-session.test.ts）。
  it('session 作成失敗時は failed を返す（受付フローを壊さない）', async () => {
    const failing = {
      createSession: async () => {
        throw new Error('boom');
      },
      issueToken: async () => {
        throw new Error('unused');
      },
    };
    const adapter = new VonageCallAdapter(
      { applicationId: 'a', apiKey: 'b', apiSecret: 'c', privateKey: 'd' },
      failing,
    );
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-sato' });
    expect(r.status).toBe('failed');
  });
});
