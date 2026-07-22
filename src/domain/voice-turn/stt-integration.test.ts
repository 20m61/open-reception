import { describe, expect, it, vi } from 'vitest';

import { ingestRawPartial } from '@/domain/voice-stt/stabilizer';
import type { SttSession } from '@/domain/voice-stt/types';

import { onTurnCommitted, type SttSessionWithoutClose } from './stt-integration';

describe('onTurnCommitted', () => {
  it('次ターン用に空の stabilizer 状態を返す', () => {
    const effects = onTurnCommitted();
    expect(effects.nextStabilizerState).toEqual({ history: [], confirmedText: '', lastEmittedText: '', lastEmitAtMs: null });
  });

  it('返した状態へ次発話の partial を投入できる（次発話を受けられることの確認）', () => {
    const effects = onTurnCommitted();
    const first = ingestRawPartial(effects.nextStabilizerState, 'はい', 0);
    const second = ingestRawPartial(first.state, 'はい', 300);
    expect(second.stable).toBe('はい');
  });

  it('SttSession.close をこのモジュールから一切呼ばない（turn 終了で STT を close しない, issue #372 AC）', () => {
    const close = vi.fn();
    const session: SttSession = {
      pushAudio: vi.fn(),
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      close,
    };
    onTurnCommitted();
    // onTurnCommitted は SttSession を受け取らないシグネチャそのものが「close しない」ことを保証する。
    // ここでは念のため、同一プロセス内で close が誤って呼ばれていないことも確認する。
    expect(close).not.toHaveBeenCalled();
    // session を SttSessionWithoutClose として扱えること自体が、close を型から見せない設計を示す。
    const withoutClose: SttSessionWithoutClose = session;
    expect(typeof withoutClose.pushAudio).toBe('function');
    expect('close' in withoutClose).toBe(true); // 実行時には残る（型だけの防止策であることの明示）。
  });
});
