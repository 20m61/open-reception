import { describe, expect, it } from 'vitest';
import {
  initialVoiceKioskState,
  voiceKioskReducer,
  captionKeyFor,
  voiceListeningStage,
  type VoiceKioskEvent,
  type VoiceKioskState,
} from './kiosk-view';

/** イベント列を初期状態から畳み込むテストヘルパ。 */
function run(events: VoiceKioskEvent[], from: VoiceKioskState = initialVoiceKioskState()): VoiceKioskState {
  return events.reduce(voiceKioskReducer, from);
}

describe('voiceKioskReducer (#364 kiosk 配線 / #361 復唱 UI の純状態機械)', () => {
  it('初期状態は inactive（音声モード未活性）', () => {
    expect(initialVoiceKioskState()).toEqual({ mode: 'inactive' });
  });

  it('activate で idle（活性・待機）へ、deactivate でいつでも inactive へ戻る', () => {
    const active = voiceKioskReducer(initialVoiceKioskState(), { type: 'activate' });
    expect(active.mode).toBe('idle');
    const back = run([{ type: 'activate' }, { type: 'listenStart' }, { type: 'deactivate' }]);
    expect(back).toEqual({ mode: 'inactive' });
  });

  it('未活性(inactive)のときは activate 以外のイベントを無視する（退行防止）', () => {
    const s = voiceKioskReducer(initialVoiceKioskState(), { type: 'listenStart' });
    expect(s.mode).toBe('inactive');
    const s2 = voiceKioskReducer(initialVoiceKioskState(), { type: 'speakStart' });
    expect(s2.mode).toBe('inactive');
  });

  it('シナリオ: 発話→復唱確認→確定→次ターン', () => {
    const heard = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'heardNeedsConfirmation', displayName: '佐藤', reason: 'low_entity_confidence' },
    ]);
    expect(heard.mode).toBe('readback');
    expect(heard.readbackName).toBe('佐藤');
    expect(heard.readbackReason).toBe('low_entity_confidence');

    // 「はい」で確定 → 次ターンのため idle（復唱情報はクリア）
    const confirmed = voiceKioskReducer(heard, { type: 'confirmYes' });
    expect(confirmed.mode).toBe('idle');
    expect(confirmed.readbackName).toBeUndefined();

    // 次ターンの発話を受け付けられる
    expect(voiceKioskReducer(confirmed, { type: 'listenStart' }).mode).toBe('listening');
  });

  it('シナリオ: 低信頼→確認→はい（別 reason でも同じ確定導線）', () => {
    const heard = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'heardNeedsConfirmation', displayName: '鈴木', reason: 'low_stt_confidence' },
    ]);
    expect(heard.mode).toBe('readback');
    expect(voiceKioskReducer(heard, { type: 'confirmYes' }).mode).toBe('idle');
  });

  it('復唱で「いいえ」を選ぶと聞き直し（listening）へ戻り復唱情報をクリアする', () => {
    const heard = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'heardNeedsConfirmation', displayName: '田中', reason: 'ambiguous_candidates' },
    ]);
    const rejected = voiceKioskReducer(heard, { type: 'confirmNo' });
    expect(rejected.mode).toBe('listening');
    expect(rejected.readbackName).toBeUndefined();
    expect(rejected.readbackReason).toBeUndefined();
  });

  it('高信頼の確定（heardAccepted）は復唱を挟まず idle（次ターン）へ', () => {
    const s = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'heardAccepted' },
    ]);
    expect(s.mode).toBe('idle');
  });

  it('シナリオ: TTS 中の割込→duck→listening（barge-in が UI 状態へ反映される）', () => {
    const speaking = run([{ type: 'activate' }, { type: 'speakStart' }]);
    expect(speaking.mode).toBe('speaking');

    const ducked = voiceKioskReducer(speaking, { type: 'bargeInDuck' });
    expect(ducked.mode).toBe('ducked');

    // duck 後にユーザー発話の取り込みが始まると listening を表示
    const listening = voiceKioskReducer(ducked, { type: 'listenStart' });
    expect(listening.mode).toBe('listening');
  });

  it('speaking が最後まで再生し終えると idle（barge-in が起きなかった場合）', () => {
    const s = run([{ type: 'activate' }, { type: 'speakStart' }, { type: 'speakEnd' }]);
    expect(s.mode).toBe('idle');
  });

  it('ducked のまま発話が途切れ speakEnd（resume 完了）でも idle へ収束する', () => {
    const s = run([{ type: 'activate' }, { type: 'speakStart' }, { type: 'bargeInDuck' }, { type: 'speakEnd' }]);
    expect(s.mode).toBe('idle');
  });

  it('シナリオ: 障害→タッチ縮退案内（fallback、source を診断用に保持）', () => {
    const s = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'fallbackRequired', source: 'stt' },
    ]);
    expect(s.mode).toBe('fallback');
    expect(s.fallbackSource).toBe('stt');
  });

  it('fallback は音声側の終端（deactivate 以外では抜けない＝タッチへ縮退したまま）', () => {
    const fell = run([{ type: 'activate' }, { type: 'fallbackRequired', source: 'transport' }]);
    // 復唱・発話イベントが来ても縮退状態を維持する
    expect(voiceKioskReducer(fell, { type: 'listenStart' }).mode).toBe('fallback');
    expect(voiceKioskReducer(fell, { type: 'speakStart' }).mode).toBe('fallback');
    // deactivate だけがリセットできる
    expect(voiceKioskReducer(fell, { type: 'deactivate' }).mode).toBe('inactive');
  });

  it('状態は不変更新される（入力 state をミューテートしない）', () => {
    const before = run([{ type: 'activate' }, { type: 'listenStart' }]);
    const snapshot = { ...before };
    voiceKioskReducer(before, { type: 'heardNeedsConfirmation', displayName: 'X', reason: 'low_stt_confidence' });
    expect(before).toEqual(snapshot);
  });
});

describe('captionKeyFor（字幕/インジケータの意味論キー導出、PII を含まない）', () => {
  it('各 mode に対応する字幕キーを返す', () => {
    expect(captionKeyFor({ mode: 'listening' })).toBe('voice.caption.listening');
    expect(captionKeyFor({ mode: 'speaking' })).toBe('voice.caption.speaking');
    expect(captionKeyFor({ mode: 'ducked' })).toBe('voice.caption.ducked');
    expect(captionKeyFor({ mode: 'readback' })).toBe('voice.readback.confirmTarget');
    expect(captionKeyFor({ mode: 'fallback' })).toBe('voice.fallback.touchNotice');
  });

  it('idle/inactive は字幕を持たない（null）', () => {
    expect(captionKeyFor({ mode: 'idle' })).toBeNull();
    expect(captionKeyFor({ mode: 'inactive' })).toBeNull();
  });
});

describe('interim 逐次字幕（#361/#364 第11wave: partial→interim→確定→復唱）', () => {
  it('初期状態・活性直後は interimText を持たない', () => {
    expect(initialVoiceKioskState().interimText).toBeUndefined();
    const active = voiceKioskReducer(initialVoiceKioskState(), { type: 'activate' });
    expect(active.interimText).toBeUndefined();
  });

  it('listening 中の hearPartial は interimText を逐次更新する（listening を維持）', () => {
    const listening = run([{ type: 'activate' }, { type: 'listenStart' }]);
    const s1 = voiceKioskReducer(listening, { type: 'hearPartial', text: 'さ' });
    expect(s1.mode).toBe('listening');
    expect(s1.interimText).toBe('さ');
    const s2 = voiceKioskReducer(s1, { type: 'hearPartial', text: 'さとう' });
    expect(s2.mode).toBe('listening');
    expect(s2.interimText).toBe('さとう');
  });

  it('idle 中の hearPartial は listening へ遷移して interim を立てる（実 orchestrator 経路で listenStart が無くても字幕が出る）', () => {
    const idle = voiceKioskReducer(initialVoiceKioskState(), { type: 'activate' });
    expect(idle.mode).toBe('idle');
    const s = voiceKioskReducer(idle, { type: 'hearPartial', text: 'す' });
    expect(s.mode).toBe('listening');
    expect(s.interimText).toBe('す');
  });

  it('新たな listenStart（聞き直し含む）は interim を空にする', () => {
    const withInterim = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'hearPartial', text: 'さとう' },
    ]);
    expect(withInterim.interimText).toBe('さとう');
    // confirmNo（聞き直し）→ listening へ戻る際 interim はクリアされる
    const readback = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'hearPartial', text: 'さ' },
      { type: 'heardNeedsConfirmation', displayName: '佐藤', reason: 'low_stt_confidence' },
    ]);
    const relisten = voiceKioskReducer(readback, { type: 'confirmNo' });
    expect(relisten.mode).toBe('listening');
    expect(relisten.interimText).toBeUndefined();
  });

  it('確定（heardNeedsConfirmation / heardAccepted）で interim はクリアされ復唱/次ターンへ置き換わる（既存フロー不変）', () => {
    const base = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'hearPartial', text: 'さとう' },
    ]);
    const readback = voiceKioskReducer(base, {
      type: 'heardNeedsConfirmation',
      displayName: '佐藤',
      reason: 'low_entity_confidence',
    });
    expect(readback.mode).toBe('readback');
    expect(readback.interimText).toBeUndefined();

    const accepted = voiceKioskReducer(base, { type: 'heardAccepted' });
    expect(accepted.mode).toBe('idle');
    expect(accepted.interimText).toBeUndefined();
  });

  it('hearPartial は inactive/fallback/readback/speaking では無視される（不変条件を壊さない）', () => {
    // inactive
    expect(voiceKioskReducer(initialVoiceKioskState(), { type: 'hearPartial', text: 'x' }).mode).toBe('inactive');
    // fallback
    const fell = run([{ type: 'activate' }, { type: 'fallbackRequired', source: 'stt' }]);
    expect(voiceKioskReducer(fell, { type: 'hearPartial', text: 'x' })).toBe(fell);
    // readback
    const readback = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'heardNeedsConfirmation', displayName: '佐藤', reason: 'low_stt_confidence' },
    ]);
    expect(voiceKioskReducer(readback, { type: 'hearPartial', text: 'x' })).toBe(readback);
    // speaking
    const speaking = run([{ type: 'activate' }, { type: 'speakStart' }]);
    expect(voiceKioskReducer(speaking, { type: 'hearPartial', text: 'x' })).toBe(speaking);
  });

  it('同一 interim の hearPartial は同一参照を返す（スナップショット安定性）', () => {
    const s = run([
      { type: 'activate' },
      { type: 'listenStart' },
      { type: 'hearPartial', text: 'さとう' },
    ]);
    expect(voiceKioskReducer(s, { type: 'hearPartial', text: 'さとう' })).toBe(s);
  });
});

describe('voiceListeningStage（聞き取り中インジケータの 2 段階導出）', () => {
  it('listening で interim 無し = idle（話しかけ待ち）、interim 有り = speech（発話検知中）', () => {
    expect(voiceListeningStage({ mode: 'listening' })).toBe('idle');
    expect(voiceListeningStage({ mode: 'listening', interimText: '' })).toBe('idle');
    expect(voiceListeningStage({ mode: 'listening', interimText: '  ' })).toBe('idle');
    expect(voiceListeningStage({ mode: 'listening', interimText: 'さとう' })).toBe('speech');
  });

  it('listening 以外は null（インジケータを出さない）', () => {
    expect(voiceListeningStage({ mode: 'idle' })).toBeNull();
    expect(voiceListeningStage({ mode: 'readback' })).toBeNull();
    expect(voiceListeningStage({ mode: 'inactive' })).toBeNull();
  });
});
