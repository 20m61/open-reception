import { describe, it, expect, vi } from 'vitest';
import type { SttSession } from '@/domain/voice-stt/types';
import { attachSttSessionClose } from './close-hook';

function fakeRegistrar() {
  const hooks: Array<() => void | Promise<void>> = [];
  return {
    registerCloseHook: (hook: () => void | Promise<void>) => hooks.push(hook),
    runAll: async () => {
      for (const hook of hooks) await hook();
    },
    hooks,
  };
}

function fakeSession(): { session: SttSession; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  return {
    session: {
      pushAudio: async () => {},
      onPartial: () => {},
      onFinal: () => {},
      close,
    },
    close,
  };
}

describe('attachSttSessionClose', () => {
  it('registers a hook that closes the STT session when invoked', async () => {
    const registrar = fakeRegistrar();
    const { session, close } = fakeSession();

    attachSttSessionClose(registrar, session);
    expect(close).not.toHaveBeenCalled();
    expect(registrar.hooks).toHaveLength(1);

    await registrar.runAll();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not require any dependency on voice-transport (structural typing only)', () => {
    // registrar は `registerCloseHook` を持つ任意のオブジェクトでよい — VoiceTransportClient を
    // import しないことが、STT の Transport への直接依存を最小に保つという設計方針の証拠になる。
    const registrar = fakeRegistrar();
    const { session } = fakeSession();
    expect(() => attachSttSessionClose(registrar, session)).not.toThrow();
  });
});
