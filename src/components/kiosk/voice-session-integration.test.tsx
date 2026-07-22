/**
 * 音声対話 注入の end-to-end 固定 (issue #364 kiosk 配線 / #361 音声復唱 UI)。
 *
 * synthetic driver → `VoiceKioskStore` → `VoiceReadbackConfirm` を連結し、AC の 4 シナリオが
 * 「注入したら」実際に UI へ現れることを固定する（薄い React フック `useVoiceSession` を挟まない分だけ
 * node 環境で決定的に検証できる。フック自体は store/component の合成にすぎない）。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceKioskStore } from '@/lib/voice-session/kiosk-store';
import { createSyntheticVoiceSession } from '@/lib/voice-session/kiosk-binding';
import { VoiceReadbackConfirm } from './VoiceReadbackConfirm';
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

function paint(store: VoiceKioskStore, locale: 'ja' | 'en' = 'ja') {
  return renderToStaticMarkup(
    <VoiceReadbackConfirm state={store.getState()} locale={locale} onYes={store.confirmYes} onNo={store.confirmNo} />,
  );
}

describe('音声対話 注入 e2e（synthetic → store → UI）', () => {
  it('シナリオ1: 発話→復唱確認→確定→次ターン が UI に現れる', () => {
    const onResolved = vi.fn();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3, onResolved });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.beginListening();
    expect(paint(store)).toContain('data-testid="voice-caption"');

    driver.hearTurn('さとう');
    const readback = paint(store);
    expect(readback).toContain('佐藤様ですね？');
    expect(readback).toContain('data-testid="voice-confirm-yes"');

    store.confirmYes();
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    // 次ターン: 再びリスニングへ
    driver.beginListening();
    expect(store.getState().mode).toBe('listening');
  });

  it('シナリオ2: 低信頼→確認→はい（confirmYes が確定＆解決を橋渡し）', () => {
    const onResolved = vi.fn();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3, onResolved });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.hearTurn('さとう');
    expect(store.getState().mode).toBe('readback');
    store.confirmYes();
    expect(store.getState().mode).toBe('idle');
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('シナリオ3: TTS 中の割込→duck→listening が字幕へ反映される', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.startSpeaking();
    expect(paint(store)).toContain('ご案内しています');
    driver.bargeIn();
    expect(store.getState().mode).toBe('ducked');
    expect(paint(store)).toContain('どうぞ');
    driver.beginListening();
    expect(store.getState().mode).toBe('listening');
  });

  it('シナリオ4: 障害→タッチ縮退案内 が UI に現れる', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    store.start();
    driver.fail('stt');
    const html = paint(store);
    expect(html).toContain('data-testid="voice-fallback-notice"');
    expect(html).toContain('画面のタッチ');
  });

  it('未注入相当（activate しない）では何も描画しない（退行なし）', () => {
    const driver = createSyntheticVoiceSession({ directory });
    const store = new VoiceKioskStore(driver.factory);
    // start を呼ばない = inactive のまま
    expect(paint(store)).toBe('');
  });
});
