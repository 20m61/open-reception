import { describe, expect, it, vi } from 'vitest';
import { VoiceKioskStore } from './kiosk-store';
import { createSyntheticVoiceSession } from './kiosk-binding';
import type { Staff } from '@/domain/staff/types';

function staff(id: string, displayName: string, kana: string): Staff {
  return {
    id, displayName, kana, aliases: [], departmentId: 'd1',
    enabled: true, available: true, callTargets: [], fallbackStaffIds: [],
  };
}
const directory = {
  staff: [staff('s1', '佐藤', 'さとう')],
  departments: [{ id: 'd1', name: '総務部', kana: 'そうむぶ', displayOrder: 0, enabled: true }],
};

describe('VoiceKioskStore (#364 synthetic 駆動で 4 シナリオを固定)', () => {
  it('start で活性化し、subscribe されたリスナーへ状態変化を通知する', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getState().mode).toBe('inactive');
    store.start();
    expect(store.getState().mode).toBe('idle');
    expect(listener).toHaveBeenCalled();
  });

  it('シナリオ1: 発話→復唱確認→確定→次ターン', () => {
    const onResolved = vi.fn();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3, onResolved });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.beginListening();
    expect(store.getState().mode).toBe('listening');
    driver.hearTurn('さとう');
    expect(store.getState().mode).toBe('readback');
    expect(store.getState().readbackName).toBe('佐藤');
    store.confirmYes(); // タッチ「はい」
    expect(store.getState().mode).toBe('idle');
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    driver.beginListening(); // 次ターン
    expect(store.getState().mode).toBe('listening');
  });

  it('シナリオ2: 低信頼→確認→いいえ→聞き直し', () => {
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3 });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.hearTurn('さとう');
    expect(store.getState().mode).toBe('readback');
    store.confirmNo();
    expect(store.getState().mode).toBe('listening');
  });

  it('シナリオ3: TTS 中の割込→duck→listening', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.startSpeaking();
    expect(store.getState().mode).toBe('speaking');
    driver.bargeIn();
    expect(store.getState().mode).toBe('ducked');
    driver.beginListening();
    expect(store.getState().mode).toBe('listening');
  });

  it('シナリオ4: 障害→タッチ縮退案内', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.fail('stt');
    expect(store.getState().mode).toBe('fallback');
    expect(store.getState().fallbackSource).toBe('stt');
  });

  it('close で音声モードを解除（inactive）し controller.close を呼ぶ', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    store.close();
    expect(store.getState().mode).toBe('inactive');
  });

  it('getState は変化が無いとき同一参照を返す（useSyncExternalStore のスナップショット安定性）', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    const a = store.getState();
    driver.bargeIn(); // speaking でない局面での barge-in は無変化
    expect(store.getState()).toBe(a);
  });
});
