import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STT_STABILIZER_CONFIG,
  emptyStabilizerState,
  ingestRawPartial,
  type SttStabilizerState,
} from './stabilizer';

const CONFIG = { stabilityWindow: 2, minEmitIntervalMs: 250, minStableChars: 2 };

function ingestAll(
  texts: { text: string; t: number }[],
  config = CONFIG,
): { state: SttStabilizerState; stables: string[] } {
  let state = emptyStabilizerState();
  const stables: string[] = [];
  for (const { text, t } of texts) {
    const result = ingestRawPartial(state, text, t, config);
    state = result.state;
    if (result.stable !== null) stables.push(result.stable);
  }
  return { state, stables };
}

describe('ingestRawPartial', () => {
  it('does not emit a stable partial before the stability window is filled', () => {
    const result = ingestRawPartial(emptyStabilizerState(), 'たなか', 0, CONFIG);
    expect(result.stable).toBeNull();
  });

  it('emits a stable partial once the same prefix repeats across the window', () => {
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 100 },
    ]);
    expect(stables).toEqual(['たなか']);
  });

  it('does not emit when the common prefix is shorter than minStableChars', () => {
    const result1 = ingestRawPartial(emptyStabilizerState(), 'た', 0, CONFIG);
    const result2 = ingestRawPartial(result1.state, 'て', 100, CONFIG);
    expect(result2.stable).toBeNull();
  });

  it('grows the stable text monotonically as raw partials extend with a common prefix', () => {
    // 実際のストリーミング ASR は同じ接頭辞を複数回繰り返してから伸びることが多い
    // （window=2 は「直近 2 回一致したら確定」を表す）。
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 300 },
      { text: 'たなかさ', t: 600 },
      { text: 'たなかさ', t: 900 },
      { text: 'たなかさま', t: 1200 },
      { text: 'たなかさま', t: 1500 },
    ]);
    // 各段階で LCP が伸びるたびに新しい stable partial が出る（後退しない）。
    expect(stables).toEqual(['たなか', 'たなかさ', 'たなかさま']);
  });

  it('suppresses re-emission within the debounce window even if the prefix changed', () => {
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 50 }, // window が一致 → 'たなか' が確定 emit
      { text: 'たなかさ', t: 60 }, // 直近 2 件の LCP はまだ 'たなか'（伸びていない）
      { text: 'たなかさ', t: 80 }, // ここで 'たなかさ' に伸びるが、直前の emit から 250ms 未満
    ]);
    // 最初の 'たなか' だけが emit され、'たなかさ' への成長はデバウンス内なので抑制される。
    expect(stables).toEqual(['たなか']);
  });

  it('eventually flushes a debounced growth once the debounce window elapses', () => {
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 50 },
      { text: 'たなかさ', t: 60 },
      { text: 'たなかさ', t: 80 },
      { text: 'たなかさ', t: 400 }, // 250ms 以上経過 → 積み残しの成長が flush される
    ]);
    expect(stables).toEqual(['たなか', 'たなかさ']);
  });

  it('does not re-emit an unchanged stable text', () => {
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 300 },
      { text: 'たなか', t: 600 },
      { text: 'たなか', t: 900 },
    ]);
    expect(stables).toEqual(['たなか']);
  });

  it('resets to the new prefix when raw partials diverge from the confirmed stable text', () => {
    // 稀なケース: 確定済みと矛盾する訂正が来た場合、新しい共通接頭辞へ切り替える。
    const { stables } = ingestAll([
      { text: 'たなか', t: 0 },
      { text: 'たなか', t: 300 },
      { text: 'さとう', t: 700 },
      { text: 'さとう', t: 1000 },
    ]);
    expect(stables).toEqual(['たなか', 'さとう']);
  });

  it('exposes a default config matching the documented defaults', () => {
    expect(DEFAULT_STT_STABILIZER_CONFIG).toEqual({
      stabilityWindow: 2,
      minEmitIntervalMs: 250,
      minStableChars: 2,
    });
  });
});
