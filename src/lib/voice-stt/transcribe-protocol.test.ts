import { describe, it, expect } from 'vitest';
import { mapTranscribeEventToFinal, mapTranscribeEventToPartial } from './transcribe-protocol';

describe('mapTranscribeEventToPartial', () => {
  it('maps a partial result to PartialTranscript with averaged item confidence', () => {
    const result = mapTranscribeEventToPartial(
      {
        Transcript: {
          Results: [
            {
              ResultId: 'r1',
              IsPartial: true,
              Alternatives: [
                {
                  Transcript: 'たなか',
                  Items: [
                    { Content: 'たなか', Confidence: 0.8, Stable: true },
                  ],
                },
              ],
            },
          ],
        },
      },
      120,
    );
    expect(result).toEqual({ text: 'たなか', stable: true, confidence: 0.8, t: 120 });
  });

  it('marks stable: false when not all items are stable yet', () => {
    const result = mapTranscribeEventToPartial(
      {
        Transcript: {
          Results: [
            {
              ResultId: 'r1',
              IsPartial: true,
              Alternatives: [
                {
                  Transcript: 'たなかさ',
                  Items: [
                    { Content: 'たなか', Confidence: 0.8, Stable: true },
                    { Content: 'さ', Confidence: 0.4, Stable: false },
                  ],
                },
              ],
            },
          ],
        },
      },
      200,
    );
    expect(result!.stable).toBe(false);
    expect(result!.confidence).toBeCloseTo(0.6);
  });

  it('defaults confidence to 0.5 when items carry no Confidence field', () => {
    const result = mapTranscribeEventToPartial(
      {
        Transcript: {
          Results: [
            { ResultId: 'r1', IsPartial: true, Alternatives: [{ Transcript: 'たなか', Items: [] }] },
          ],
        },
      },
      0,
    );
    expect(result!.confidence).toBe(0.5);
    expect(result!.stable).toBe(false);
  });

  it('returns null when there is no partial result in the event', () => {
    const result = mapTranscribeEventToPartial(
      { Transcript: { Results: [{ ResultId: 'r1', IsPartial: false, Alternatives: [{ Transcript: 'x' }] }] } },
      0,
    );
    expect(result).toBeNull();
  });

  it('returns null when there is no alternative', () => {
    const result = mapTranscribeEventToPartial(
      { Transcript: { Results: [{ ResultId: 'r1', IsPartial: true, Alternatives: [] }] } },
      0,
    );
    expect(result).toBeNull();
  });
});

describe('mapTranscribeEventToFinal', () => {
  it('maps a non-partial result to FinalTranscript', () => {
    const result = mapTranscribeEventToFinal(
      {
        Transcript: {
          Results: [
            {
              ResultId: 'r2',
              IsPartial: false,
              Alternatives: [
                { Transcript: '田中です', Items: [{ Content: '田中です', Confidence: 0.95 }] },
              ],
            },
          ],
        },
      },
      900,
    );
    expect(result).toEqual({ text: '田中です', confidence: 0.95, t: 900 });
  });

  it('returns null when the event only carries partial results', () => {
    const result = mapTranscribeEventToFinal(
      { Transcript: { Results: [{ ResultId: 'r1', IsPartial: true, Alternatives: [{ Transcript: 'x' }] }] } },
      0,
    );
    expect(result).toBeNull();
  });
});
