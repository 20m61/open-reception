import { describe, expect, it, vi } from 'vitest';
import { createSyntheticVoiceSession, createOrchestratorVoiceSession, type VoiceSessionLike } from './kiosk-binding';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import type { VoiceSessionCallbacks } from './orchestrator';
import type { Staff } from '@/domain/staff/types';

function staff(id: string, displayName: string, kana: string): Staff {
  return {
    id, displayName, kana, aliases: [], departmentId: 'd1',
    enabled: true, available: true, callTargets: [], fallbackStaffIds: [],
  };
}

const directory = {
  staff: [staff('s1', '佐藤', 'さとう'), staff('s2', '鈴木', 'すずき')],
  departments: [{ id: 'd1', name: '総務部', kana: 'そうむぶ', displayOrder: 0, enabled: true }],
};

/** emit を集めるヘルパ。 */
function collector() {
  const events: VoiceKioskEvent[] = [];
  return { emit: (e: VoiceKioskEvent) => events.push(e), events };
}

describe('createSyntheticVoiceSession (#364 mock synthetic 駆動 / demo-studio 再現用)', () => {
  it('高信頼発話は heardAccepted を emit する', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95 });
    driver.factory(emit);
    driver.beginListening();
    driver.hearTurn('さとう');
    expect(events).toContainEqual({ type: 'listenStart' });
    expect(events).toContainEqual({ type: 'heardAccepted' });
  });

  it('低信頼発話は復唱確認（heardNeedsConfirmation）を emit し、confirmYes/No が確定/聞き直しを emit する', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3 });
    const controller = driver.factory(emit);
    driver.beginListening();
    driver.hearTurn('さとう');
    expect(events).toContainEqual({ type: 'heardNeedsConfirmation', displayName: '佐藤', reason: 'low_stt_confidence' });

    controller.confirmYes();
    expect(events).toContainEqual({ type: 'confirmYes' });

    // 別セッションで No 経路
    const c2 = collector();
    const d2 = createSyntheticVoiceSession({ directory, sttConfidence: 0.3 });
    const ctrl2 = d2.factory(c2.emit);
    d2.hearTurn('さとう');
    ctrl2.confirmNo();
    expect(c2.events).toContainEqual({ type: 'confirmNo' });
  });

  it('barge-in と障害を emit する（TTS 割込・タッチ縮退）', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory });
    driver.factory(emit);
    driver.startSpeaking();
    driver.bargeIn();
    driver.beginListening();
    expect(events).toEqual([
      { type: 'speakStart' },
      { type: 'bargeInDuck' },
      { type: 'listenStart' },
    ]);

    const c2 = collector();
    const d2 = createSyntheticVoiceSession({ directory });
    d2.factory(c2.emit);
    d2.fail('stt');
    expect(c2.events).toContainEqual({ type: 'fallbackRequired', source: 'stt' });
  });

  it('確定コールバック(onResolved)へ解決済み候補を渡す（既存選択への橋渡し）', () => {
    const onResolved = vi.fn();
    const { emit } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95, onResolved });
    driver.factory(emit);
    driver.hearTurn('さとう');
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });
});

describe('createOrchestratorVoiceSession (実 orchestrator を束ねる seam・fake で検証)', () => {
  function fakeOrchestrator() {
    const calls: string[] = [];
    let captured: VoiceSessionCallbacks | null = null;
    const like: VoiceSessionLike = {
      start: () => { calls.push('start'); },
      close: () => { calls.push('close'); },
      resetTurn: () => { calls.push('resetTurn'); },
    };
    const construct = (cb: VoiceSessionCallbacks) => { captured = cb; return like; };
    return { construct, calls, getCallbacks: () => captured };
  }

  it('onTurnCommitted を Entity 解決経由で UI イベントへ写像し、高信頼は heardAccepted + onResolved', () => {
    const onResolved = vi.fn();
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.95, onResolved });
    factory(emit);
    fake.getCallbacks()!.onTurnCommitted!('さとう', 'silence');
    expect(events).toContainEqual({ type: 'heardAccepted' });
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('低信頼の onTurnCommitted は復唱確認を emit し、confirmYes で resetTurn + onResolved する', () => {
    const onResolved = vi.fn();
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.3, onResolved });
    const controller = factory(emit);
    fake.getCallbacks()!.onTurnCommitted!('さとう', 'silence');
    expect(events).toContainEqual(expect.objectContaining({ type: 'heardNeedsConfirmation', displayName: '佐藤' }));

    controller.confirmYes();
    expect(events).toContainEqual({ type: 'confirmYes' });
    expect(fake.calls).toContain('resetTurn');
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('onVrmStateChange を speakStart/speakEnd へ、非 TTS 由来の onFallback を fallbackRequired へ写像する', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    const cb = fake.getCallbacks()!;
    cb.onVrmStateChange!('speaking');
    cb.onVrmStateChange!('listening');
    expect(events).toContainEqual({ type: 'speakStart' });
    expect(events).toContainEqual({ type: 'speakEnd' });

    cb.onFallback!({ type: 'voiceSessionFallbackRequired', source: 'transport', reason: 'x', t: 1 });
    expect(events).toContainEqual({ type: 'fallbackRequired', source: 'transport' });
  });

  it('TTS 由来の onFallback はタッチ強制切替にしない（継続可能なので fallbackRequired を emit しない）', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    fake.getCallbacks()!.onFallback!({ type: 'voiceSessionFallbackRequired', source: 'tts', reason: 'caption_only', t: 2 });
    expect(events.some((e) => e.type === 'fallbackRequired')).toBe(false);
  });

  it('start/close を配下 orchestrator へ委譲する', () => {
    const fake = fakeOrchestrator();
    const { emit } = collector();
    const controller = createOrchestratorVoiceSession(fake.construct, { directory })(emit);
    void controller.start();
    void controller.close();
    expect(fake.calls).toContain('start');
    expect(fake.calls).toContain('close');
  });

  it('notifyReceptionState (#364/#363/#361 第9wave) を実装しない — 実 orchestrator 経路は受付局面通知の影響を受けない（中立な no-op 契約）', () => {
    const fake = fakeOrchestrator();
    const { emit } = collector();
    const controller = createOrchestratorVoiceSession(fake.construct, { directory })(emit);
    expect(controller.notifyReceptionState).toBeUndefined();
  });
});
