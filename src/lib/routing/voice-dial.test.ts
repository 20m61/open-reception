/**
 * 実 PSTN 発信者の解決 (#4 Inc D-2 項目 2)。
 *
 * ここで固定したいのは「**いつ実発信できるか**」の境界そのもの。設定が半端なテナントで
 * 発信者が組み上がってしまうと、資格情報の欠けたまま `POST /v1/calls` を叩くか、
 * 誤った発信元番号で電話を鳴らすことになる。**欠けていたら mock へ倒す（fail-closed）。**
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue } from '@/domain/provider-config/secret';
import type { ResolvedProvider } from '@/lib/platform/provider-resolution';
import { buildVoiceCredentials, resolveVoiceInitiator } from './voice-dial';

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST-KEY\\n-----END PRIVATE KEY-----';

function vonageResolved(over: {
  settings?: Partial<Extract<ResolvedProvider, { provider: 'vonage' }>['settings']>;
  bundle?: Record<string, unknown>;
} = {}): ResolvedProvider {
  return {
    provider: 'vonage',
    settings: { applicationId: 'TEST-app', fromNumber: '+815012345678', ...over.settings },
    secret: new SecretValue(JSON.stringify(over.bundle ?? { privateKey: PRIVATE_KEY })),
  };
}

describe('buildVoiceCredentials — 実発信の資格情報が揃っているか', () => {
  it('applicationId / privateKey / fromNumber が揃っていれば組み上がる', () => {
    const creds = buildVoiceCredentials(vonageResolved());
    expect(creds).not.toBeNull();
    expect(creds?.applicationId).toBe('TEST-app');
    expect(creds?.fromNumber).toBe('+815012345678');
  });

  it('PEM の \\n エスケープを実改行へ戻す（1 行 secret に入っている前提）', () => {
    const creds = buildVoiceCredentials(vonageResolved());
    expect(creds?.privateKeyPem).toContain('\n');
    expect(creds?.privateKeyPem).not.toContain('\\n');
  });

  it.each([
    ['applicationId 未設定', { settings: { applicationId: undefined } }],
    ['fromNumber 未設定', { settings: { fromNumber: undefined } }],
    ['privateKey 未設定', { bundle: {} }],
    ['privateKey が文字列でない', { bundle: { privateKey: 42 } }],
  ])('%s なら null（fail-closed）', (_name, over) => {
    expect(buildVoiceCredentials(vonageResolved(over))).toBeNull();
  });

  it('secret が JSON でなければ null（例外を投げない）', () => {
    const resolved: ResolvedProvider = {
      provider: 'vonage',
      settings: { applicationId: 'TEST-app', fromNumber: '+815012345678' },
      secret: new SecretValue('not-json'),
    };
    expect(buildVoiceCredentials(resolved)).toBeNull();
  });
});

describe('resolveVoiceInitiator — 実発信者を解決できるか', () => {
  const deps = {
    signJwt: () => 'TEST-jwt',
    fetch: vi.fn(),
    resolveEndpoint: vi.fn(),
  };

  it('テナントが mock 解決なら null（実発信しない）', async () => {
    const initiator = await resolveVoiceInitiator('t1', 'https://example.test', {
      ...deps,
      resolveProvider: async () => ({ provider: 'mock' }),
    });
    expect(initiator).toBeNull();
  });

  it('vonage でも資格情報が欠けていれば null', async () => {
    const initiator = await resolveVoiceInitiator('t1', 'https://example.test', {
      ...deps,
      resolveProvider: async () => vonageResolved({ bundle: {} }),
    });
    expect(initiator).toBeNull();
  });

  it('vonage かつ資格情報完備なら initiator を返す', async () => {
    const initiator = await resolveVoiceInitiator('t1', 'https://example.test', {
      ...deps,
      resolveProvider: async () => vonageResolved(),
    });
    expect(initiator).not.toBeNull();
    expect(initiator?.key).toBe('vonage-voice');
  });
});

/**
 * 新規発信の停止スイッチ (#4 Inc D-2 項目 2)。
 *
 * 🔴 `PROVIDER_WEBHOOKS_DISABLED` は **webhook（発信後の進行）しか止めない**。
 * 実発信を配線した以上、「これ以上**新しく電話を鳴らさない**」手段が別に要る。
 * 発信の入口は 1 つ（この関数）なので、ここで止めれば全経路が止まる。
 */
describe('VOICE_DIALING_DISABLED — 新規発信の停止スイッチ', () => {
  const deps = {
    signJwt: () => 'TEST-jwt',
    fetch: vi.fn(),
    resolveEndpoint: vi.fn(),
    resolveProvider: async () => vonageResolved(),
  };

  afterEach(() => {
    delete process.env.VOICE_DIALING_DISABLED;
  });

  it.each(['1', 'true', 'ON', ' yes '])('%s なら null（＝mock 経路へ倒れる）', async (raw) => {
    process.env.VOICE_DIALING_DISABLED = raw;
    expect(await resolveVoiceInitiator('t1', 'https://example.test', deps)).toBeNull();
  });

  it.each(['', '0', 'false', 'maybe'])(
    '%s は停止扱いにしない（誤記で意図せず全断しない）',
    async (raw) => {
      process.env.VOICE_DIALING_DISABLED = raw;
      expect(await resolveVoiceInitiator('t1', 'https://example.test', deps)).not.toBeNull();
    },
  );

  it('未設定なら発信できる（既定は稼働）', async () => {
    expect(await resolveVoiceInitiator('t1', 'https://example.test', deps)).not.toBeNull();
  });

  it('🔴 停止判定は資格情報の解決より前（止めたい状況で secret を読ませない）', async () => {
    process.env.VOICE_DIALING_DISABLED = '1';
    let asked = 0;
    await resolveVoiceInitiator('t1', 'https://example.test', {
      ...deps,
      resolveProvider: async () => {
        asked += 1;
        return vonageResolved();
      },
    });
    expect(asked).toBe(0);
  });
});
