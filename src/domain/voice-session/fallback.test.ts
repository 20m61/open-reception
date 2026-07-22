import { describe, it, expect } from 'vitest';
import { normalizeTransportFallback, normalizeSttFallback, normalizeTtsFallback, normalizeTurnFallback } from './fallback';

describe('voice-session fallback normalization (issue #364 統合: どの層の障害でも1つのfallbackイベントに正規化)', () => {
  it('normalizeTransportFallback maps VoiceTransportFallbackEvent to the common shape (source: transport)', () => {
    const event = normalizeTransportFallback({ type: 'voiceTransportFallbackRequired', reason: 'reconnect_exhausted', t: 100 });
    expect(event).toEqual({ type: 'voiceSessionFallbackRequired', source: 'transport', reason: 'reconnect_exhausted', t: 100 });
  });

  it('normalizeSttFallback maps VoiceSttFallbackEvent to the common shape (source: stt)', () => {
    const event = normalizeSttFallback({ type: 'voiceSttFallbackRequired', reason: 'no_partial_timeout', t: 200 });
    expect(event).toEqual({ type: 'voiceSessionFallbackRequired', source: 'stt', reason: 'no_partial_timeout', t: 200 });
  });

  it('normalizeTtsFallback maps a TtsFailureReason to the common shape (source: tts)', () => {
    const event = normalizeTtsFallback('provider_error', 300);
    expect(event).toEqual({ type: 'voiceSessionFallbackRequired', source: 'tts', reason: 'provider_error', t: 300 });
  });

  it('normalizeTurnFallback maps a VoiceTurnErrorCode to the common shape (source: turn)', () => {
    const event = normalizeTurnFallback('vad_unavailable', 400);
    expect(event).toEqual({ type: 'voiceSessionFallbackRequired', source: 'turn', reason: 'vad_unavailable', t: 400 });
  });

  it('all four sources converge on the exact same event shape (uniform union for a single Kiosk subscription)', () => {
    const events = [
      normalizeTransportFallback({ type: 'voiceTransportFallbackRequired', reason: 'runtime_stopped', t: 1 }),
      normalizeSttFallback({ type: 'voiceSttFallbackRequired', reason: 'provider_unavailable', t: 2 }),
      normalizeTtsFallback('timeout', 3),
      normalizeTurnFallback('stop_playback_failed', 4),
    ];
    for (const event of events) {
      expect(event.type).toBe('voiceSessionFallbackRequired');
      expect(Object.keys(event).sort()).toEqual(['reason', 'source', 't', 'type']);
    }
    expect(events.map((e) => e.source)).toEqual(['transport', 'stt', 'tts', 'turn']);
  });
});
