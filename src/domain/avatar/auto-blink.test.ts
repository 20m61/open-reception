import { describe, it, expect } from 'vitest';
import {
  createAutoBlinkState,
  stepAutoBlink,
  blinkCurveWeight,
  BLINK_MIN_INTERVAL_MS,
  BLINK_MAX_INTERVAL_MS,
  BLINK_DURATION_MS,
  type AutoBlinkState,
} from './auto-blink';

/**
 * auto-blink（自動まばたきの周期駆動, issue #31 増分）の純関数テスト。
 * 3D 描画は jsdom で検証できないため、「経過時間(ms) + seed → 次のまばたき時刻・
 * 閉眼→開眼の重みカーブ」を計算する部分だけを純関数として切り出して固定する。
 * viewer 結線の固定は `components/kiosk/avatar/frame-weights.test.ts` 側で行う。
 */
describe('createAutoBlinkState / stepAutoBlink (#31 auto-blink 周期駆動)', () => {
  it('同じ seed からは同じ初期状態が決定論的に生成される', () => {
    const a = createAutoBlinkState(42);
    const b = createAutoBlinkState(42);
    expect(a).toEqual(b);
  });

  it('異なる seed からは（高確率で）異なる初期状態が生成される', () => {
    const a = createAutoBlinkState(1);
    const b = createAutoBlinkState(2);
    expect(a).not.toEqual(b);
  });

  it('初回のまばたき予定時刻は設計レンジ [MIN, MAX] 内に収まる', () => {
    for (let seed = 0; seed < 50; seed++) {
      const state = createAutoBlinkState(seed);
      expect(state.nextBlinkAtMs).toBeGreaterThanOrEqual(BLINK_MIN_INTERVAL_MS);
      expect(state.nextBlinkAtMs).toBeLessThanOrEqual(BLINK_MAX_INTERVAL_MS);
    }
  });

  it('seed=0 でも fail-safe に有効な状態を生成する（xorshift の退化状態を回避）', () => {
    const state = createAutoBlinkState(0);
    expect(Number.isFinite(state.nextBlinkAtMs)).toBe(true);
    expect(state.nextBlinkAtMs).toBeGreaterThanOrEqual(BLINK_MIN_INTERVAL_MS);
    expect(state.nextBlinkAtMs).toBeLessThanOrEqual(BLINK_MAX_INTERVAL_MS);
  });

  it('予定時刻に満たない間は重み0で状態も変化しない', () => {
    const state = createAutoBlinkState(7);
    const frame = stepAutoBlink(state, state.nextBlinkAtMs - 1);
    expect(frame.weight).toBe(0);
    expect(frame.state).toEqual(state);
  });

  it('予定時刻に到達するとまばたきが始まり、経過に応じて 0→max→0 のカーブを描く', () => {
    const state = createAutoBlinkState(7);
    const start = stepAutoBlink(state, state.nextBlinkAtMs);
    expect(start.weight).toBe(0); // まばたき開始直後(閉眼開始点)は0
    expect(start.state.activeBlinkStartMs).toBe(state.nextBlinkAtMs);

    const mid = stepAutoBlink(start.state, state.nextBlinkAtMs + BLINK_DURATION_MS / 2);
    expect(mid.weight).toBeCloseTo(1, 5); // 中間点で最大(閉眼)

    const end = stepAutoBlink(start.state, state.nextBlinkAtMs + BLINK_DURATION_MS);
    expect(end.weight).toBe(0); // 完了時点で開眼(0)に戻る
  });

  it('まばたき完了後は次のまばたきが設計レンジ内の間隔で再スケジュールされる', () => {
    const state = createAutoBlinkState(11);
    const blinkStart = stepAutoBlink(state, state.nextBlinkAtMs);
    const rescheduled = stepAutoBlink(blinkStart.state, state.nextBlinkAtMs + BLINK_DURATION_MS);
    expect(rescheduled.weight).toBe(0);
    expect(rescheduled.state.activeBlinkStartMs).toBeNull();
    const interval = rescheduled.state.nextBlinkAtMs - (state.nextBlinkAtMs + BLINK_DURATION_MS);
    expect(interval).toBeGreaterThanOrEqual(BLINK_MIN_INTERVAL_MS);
    expect(interval).toBeLessThanOrEqual(BLINK_MAX_INTERVAL_MS);
  });

  it('同一 seed・同一時刻系列からは常に同じ重み系列が再現される（決定論）', () => {
    const timestamps = [0, 1500, 3000, 3100, 3200, 3300, 3400, 8000, 8050];
    const run = (): number[] => {
      let state = createAutoBlinkState(99);
      const weights: number[] = [];
      for (const t of timestamps) {
        const frame = stepAutoBlink(state, t);
        state = frame.state;
        weights.push(frame.weight);
      }
      return weights;
    };
    expect(run()).toEqual(run());
  });

  it('時間逆行（前回より小さい経過時間）が来ても状態を壊さず重み0を返す(fail-safe)', () => {
    const state = createAutoBlinkState(3);
    const started = stepAutoBlink(state, state.nextBlinkAtMs + 10);
    // まばたき中に時刻が巻き戻る
    const rewound = stepAutoBlink(started.state, started.state.activeBlinkStartMs! - 5);
    expect(rewound.weight).toBe(0);
    expect(rewound.state).toEqual(started.state);
  });

  it('負値・NaN・Infinity の経過時間は重み0・状態不変で fail-safe に扱う', () => {
    const state = createAutoBlinkState(5);
    for (const bad of [-1, NaN, Infinity, -Infinity]) {
      const frame = stepAutoBlink(state, bad);
      expect(frame.weight).toBe(0);
      expect(frame.state).toEqual(state);
    }
  });

  it('大きく時間が飛んでも例外を投げず、以降のフレームで自己修復してまばたきを再開する', () => {
    const state = createAutoBlinkState(13);
    const jumped = stepAutoBlink(state, state.nextBlinkAtMs + 10_000_000); // 想定外の大ジャンプ
    expect(Number.isFinite(jumped.weight)).toBe(true);
    // 1フレーム後には完了扱いとなり、次のまばたきが設計レンジ内で再スケジュールされる
    const next = stepAutoBlink(jumped.state, state.nextBlinkAtMs + 10_000_000 + 1);
    expect(next.state.activeBlinkStartMs).toBeNull();
  });
});

describe('blinkCurveWeight (#31 まばたきの閉眼→開眼カーブ)', () => {
  it('カーブは 0→max(1)→0 の滑らかな形状（境界と中間点）', () => {
    expect(blinkCurveWeight(0)).toBe(0);
    expect(blinkCurveWeight(BLINK_DURATION_MS)).toBe(0); // 終了時点ちょうどは0
    expect(blinkCurveWeight(BLINK_DURATION_MS / 2)).toBeCloseTo(1, 5); // 中間で最大
  });

  it('単調増加区間・単調減少区間になっている(滑らかさの近似確認)', () => {
    const samples: number[] = Array.from({ length: 11 }, (_, i) =>
      blinkCurveWeight((BLINK_DURATION_MS * i) / 10),
    );
    const half = Math.floor(samples.length / 2);
    for (let i = 1; i <= half; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    for (let i = half + 1; i < samples.length; i++) {
      expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    }
  });

  it('負値・duration超過は0(fail-safe)', () => {
    expect(blinkCurveWeight(-1)).toBe(0);
    expect(blinkCurveWeight(BLINK_DURATION_MS + 1)).toBe(0);
  });

  it('duration が非数・0以下でも例外を投げず0を返す(fail-safe)', () => {
    expect(blinkCurveWeight(10, 0)).toBe(0);
    expect(blinkCurveWeight(10, -100)).toBe(0);
    expect(blinkCurveWeight(10, NaN)).toBe(0);
  });

  it('NaN/Infinity の経過時間は0(fail-safe)', () => {
    expect(blinkCurveWeight(NaN)).toBe(0);
    expect(blinkCurveWeight(Infinity)).toBe(0);
  });
});

describe('設計レンジの妥当性', () => {
  it('BLINK_MIN_INTERVAL_MS < BLINK_MAX_INTERVAL_MS で、まばたき動作時間より十分長い', () => {
    expect(BLINK_MIN_INTERVAL_MS).toBeLessThan(BLINK_MAX_INTERVAL_MS);
    expect(BLINK_MIN_INTERVAL_MS).toBeGreaterThan(BLINK_DURATION_MS * 2);
  });

  it('型: AutoBlinkState は活性/非活性いずれかを一意に表す', () => {
    const idle: AutoBlinkState = createAutoBlinkState(1);
    expect(idle.activeBlinkStartMs).toBeNull();
  });
});
