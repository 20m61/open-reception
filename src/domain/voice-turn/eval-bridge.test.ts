import { describe, expect, it } from 'vitest';

import { validateVoiceEvalSession, VOICE_EVAL_SCHEMA_VERSION } from '@/domain/voice/evaluation-events';

import {
  audioOnsetEvent,
  bargeInPlaybackStoppedEvent,
  speechEndEvent,
  turnCommittedEvent,
  turnErrorEvent,
  turnSessionAbortedEvent,
  VOICE_TURN_ERROR_CODES,
} from './eval-bridge';

describe('eval-bridge', () => {
  it('speechEndEvent は speech.end を生成する', () => {
    expect(speechEndEvent(100, 2)).toEqual({ type: 'speech.end', t: 100, turnIndex: 2 });
  });

  it('turnCommittedEvent は turn.committed を trigger 付きで生成する', () => {
    expect(turnCommittedEvent(150, 'はい', 'silence', 0)).toEqual({
      type: 'turn.committed',
      t: 150,
      turnIndex: 0,
      text: 'はい',
      trigger: 'silence',
    });
  });

  it('audioOnsetEvent は audio.onset を生成する（近端発話にも流用できる共通形）', () => {
    expect(audioOnsetEvent(1200, 1)).toEqual({ type: 'audio.onset', t: 1200, turnIndex: 1 });
  });

  it('bargeInPlaybackStoppedEvent は reason: barge_in の tts.playback_stopped を生成する', () => {
    expect(bargeInPlaybackStoppedEvent(1500, 0)).toEqual({
      type: 'tts.playback_stopped',
      t: 1500,
      turnIndex: 0,
      reason: 'barge_in',
    });
  });

  it('turnErrorEvent / turnSessionAbortedEvent は stage: turn で列挙コードのみ許可する', () => {
    for (const code of VOICE_TURN_ERROR_CODES) {
      expect(turnErrorEvent(0, code)).toEqual({ type: 'error', t: 0, turnIndex: 0, stage: 'turn', code });
      expect(turnSessionAbortedEvent(0, code)).toEqual({ type: 'session.aborted', t: 0, turnIndex: 0, stage: 'turn', code });
    }
  });

  it('生成したイベント列は #365 共通スキーマの検証を単体でも満たす（tts.request 前置きを含めれば）', () => {
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'eval-bridge-test',
      locale: 'ja-JP',
      providers: { stt: 'x', tts: 'x', turn: 'voice-turn' },
      events: [
        audioOnsetEvent(0, 0),
        speechEndEvent(300, 0),
        turnCommittedEvent(550, 'はい', 'silence', 0),
        { type: 'tts.request' as const, t: 560, turnIndex: 0, text: '承知しました' },
        { type: 'tts.playback_start' as const, t: 700, turnIndex: 0 },
        audioOnsetEvent(900, 0),
        bargeInPlaybackStoppedEvent(1050, 0),
      ],
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    expect(validateVoiceEvalSession(session).errors).toEqual([]);
  });
});
