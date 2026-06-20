/**
 * VonageCallClient の単体テスト。実 SDK の代わりに fake VideoSdk を注入し、
 * connect/publish/streamCreated→onConnected、接続エラー、SDK ロード失敗、disconnect を検証する。
 * 実 SDK の DOM ロード（defaultLoadSdk）はブラウザ専用のため対象外（要ライブ検証）。
 */
import { describe, it, expect, vi } from 'vitest';
import { VonageCallClient, type VideoSdk, type VideoSession } from './vonage-client';

function makeSdk(connectError?: unknown) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const session: VideoSession = {
    connect: vi.fn((_token: string, cb: (e?: unknown) => void) => cb(connectError)),
    publish: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      handlers[event] = handler;
    }),
    disconnect: vi.fn(),
  };
  const sdk: VideoSdk = {
    initSession: vi.fn(() => session),
    initPublisher: vi.fn(() => ({})),
  };
  return { sdk, session, fireStreamCreated: () => handlers['streamCreated']?.({}) };
}

const baseOpts = {
  applicationId: 'app-1',
  sessionId: 'sess-1',
  token: 'jwt',
};

describe('VonageCallClient', () => {
  it('connects, publishes, and signals onConnected when a remote stream appears', async () => {
    const { sdk, session, fireStreamCreated } = makeSdk();
    const onConnected = vi.fn();
    const onError = vi.fn();
    const client = new VonageCallClient({ loadSdk: async () => sdk });

    await client.connect({ ...baseOpts, onConnected, onError });
    expect(sdk.initSession).toHaveBeenCalledWith('app-1', 'sess-1');
    expect(session.connect).toHaveBeenCalled();
    expect(session.publish).toHaveBeenCalled(); // 接続成功 → publisher を publish
    expect(onConnected).not.toHaveBeenCalled();

    fireStreamCreated(); // 担当者参加
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports onError when session.connect fails', async () => {
    const { sdk, session } = makeSdk(new Error('connect-failed'));
    const onError = vi.fn();
    const client = new VonageCallClient({ loadSdk: async () => sdk });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(session.publish).not.toHaveBeenCalled(); // エラー時は publish しない
  });

  it('reports onError when the SDK fails to load', async () => {
    const onError = vi.fn();
    const client = new VonageCallClient({
      loadSdk: async () => {
        throw new Error('sdk load failed');
      },
    });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('disconnect() tears down the session safely', async () => {
    const { sdk, session } = makeSdk();
    const client = new VonageCallClient({ loadSdk: async () => sdk });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError: vi.fn() });
    await client.disconnect();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await expect(client.disconnect()).resolves.toBeUndefined(); // 二重 disconnect も安全
  });
});
