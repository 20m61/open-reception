import { describe, expect, it } from 'vitest';
import {
  CALLING_STAGES,
  DEFAULT_CALLING_STAGE_THRESHOLDS,
  clampCallingStageThresholds,
  deriveCallingStage,
  timeoutDispatchDelayMs,
  timeoutDispatchGateMs,
} from './calling-experience';

describe('deriveCallingStage (#323)', () => {
  it('経過 0ms は dialing 段階', () => {
    expect(deriveCallingStage(0)).toBe('dialing');
  });

  it('waitingAfterMs ちょうどで waiting 段階へ切り替わる', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(deriveCallingStage(t.waitingAfterMs - 1, t)).toBe('dialing');
    expect(deriveCallingStage(t.waitingAfterMs, t)).toBe('waiting');
  });

  it('noticeAfterMs ちょうどで preTimeoutNotice 段階へ切り替わる', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(deriveCallingStage(t.noticeAfterMs - 1, t)).toBe('waiting');
    expect(deriveCallingStage(t.noticeAfterMs, t)).toBe('preTimeoutNotice');
  });

  it('しきい値を短縮しても同じ順序で段階が進む（E2E タイマー短縮の想定）', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 100, noticeAfterMs: 250, noticeMinDurationMs: 100 });
    expect(deriveCallingStage(0, t)).toBe('dialing');
    expect(deriveCallingStage(150, t)).toBe('waiting');
    expect(deriveCallingStage(300, t)).toBe('preTimeoutNotice');
  });

  it('CALLING_STAGES は 3 段階を dialing→waiting→preTimeoutNotice の順で網羅する', () => {
    expect(CALLING_STAGES).toEqual(['dialing', 'waiting', 'preTimeoutNotice']);
  });
});

describe('clampCallingStageThresholds (#323)', () => {
  it('未指定は既定値を返す', () => {
    expect(clampCallingStageThresholds(undefined)).toEqual(DEFAULT_CALLING_STAGE_THRESHOLDS);
    expect(clampCallingStageThresholds(null)).toEqual(DEFAULT_CALLING_STAGE_THRESHOLDS);
  });

  it('正の有限値は採用する', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 5000, noticeAfterMs: 12000, noticeMinDurationMs: 2000 });
    expect(t).toEqual({ waitingAfterMs: 5000, noticeAfterMs: 12000, noticeMinDurationMs: 2000 });
  });

  it('不正値（0/負/NaN/Infinity/非数値）は既定へフォールバックする', () => {
    const base = DEFAULT_CALLING_STAGE_THRESHOLDS;
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const t = clampCallingStageThresholds({ waitingAfterMs: bad, noticeAfterMs: bad, noticeMinDurationMs: bad });
      expect(t).toEqual(base);
    }
  });

  it('noticeAfterMs が waitingAfterMs 以下なら waitingAfterMs+マージンへ引き上げる（順序不変条件）', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 10_000, noticeAfterMs: 5_000 });
    expect(t.noticeAfterMs).toBeGreaterThan(t.waitingAfterMs);
  });

  it('noticeAfterMs === waitingAfterMs でも順序不変条件を保つ', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 8_000, noticeAfterMs: 8_000 });
    expect(t.noticeAfterMs).toBeGreaterThan(t.waitingAfterMs);
  });

  it('base を明示すると、その値を fallback として使う（多段マージ: テナント設定 → E2E クエリ）', () => {
    const tenant = clampCallingStageThresholds({ waitingAfterMs: 20_000 });
    const merged = clampCallingStageThresholds({ noticeAfterMs: 30_000 }, tenant);
    expect(merged.waitingAfterMs).toBe(20_000); // テナント設定を継承
    expect(merged.noticeAfterMs).toBe(30_000); // クエリで上書き
  });
});

describe('timeoutDispatchDelayMs (#323 AC3: 予告付きタイムアウト遷移)', () => {
  it('経過が noticeAfterMs+noticeMinDurationMs 以上なら遅延不要（0）', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    const earliest = t.noticeAfterMs + t.noticeMinDurationMs;
    expect(timeoutDispatchDelayMs(earliest, t)).toBe(0);
    expect(timeoutDispatchDelayMs(earliest + 10_000, t)).toBe(0);
  });

  it('経過が浅い場合は、予告を最低 noticeMinDurationMs 見せる分だけ遅延させる', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    // モック応答は瞬時に返る想定（elapsed=0）でも、予告 + 保持時間ぶんは遅らせる。
    expect(timeoutDispatchDelayMs(0, t)).toBe(t.noticeAfterMs + t.noticeMinDurationMs);
  });

  it('予告段階に入った直後（notice 開始時点）は noticeMinDurationMs まるごと遅延する', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(timeoutDispatchDelayMs(t.noticeAfterMs, t)).toBe(t.noticeMinDurationMs);
  });

  it('短縮しきい値でも一貫した計算になる（E2E 決定性）', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 100, noticeAfterMs: 250, noticeMinDurationMs: 150 });
    expect(timeoutDispatchDelayMs(0, t)).toBe(400);
    expect(timeoutDispatchDelayMs(250, t)).toBe(150);
    expect(timeoutDispatchDelayMs(400, t)).toBe(0);
  });
});

describe('timeoutDispatchGateMs (#826: 予告を「描画してから」数える)', () => {
  const t = clampCallingStageThresholds({
    waitingAfterMs: 200,
    noticeAfterMs: 500,
    noticeMinDurationMs: 300,
  });

  it('予告をまだ描画していない間は dispatch を許可しない（null）', () => {
    expect(timeoutDispatchGateMs(null, 10_000, t)).toBeNull();
  });

  it('描画直後は noticeMinDurationMs まるごと待たせる', () => {
    expect(timeoutDispatchGateMs(1_000, 1_000, t)).toBe(300);
  });

  it('保持時間を満たしたら 0（即時許可）', () => {
    expect(timeoutDispatchGateMs(1_000, 1_300, t)).toBe(0);
    expect(timeoutDispatchGateMs(1_000, 9_999, t)).toBe(0);
  });

  /**
   * 不変条件（上界）: **0 を返した ⟹ 予告は必ず noticeMinDurationMs 以上描画されている**。
   * 経過時刻・しきい値の組合せを総当たりして縛る。「経過が深ければ即時」という
   * 旧 timeoutDispatchDelayMs の近道（描画を確認しない）が復活したら落ちる。
   */
  it('0 を返すのは、予告が保持時間ぶん描画された後だけ', () => {
    for (const requested of [1, 100, 300, 5_000]) {
      const th = clampCallingStageThresholds({ noticeMinDurationMs: requested }, t);
      // clampCallingStageThresholds は 100ms 未満を弾くので、**実効値**で縛る（要求値ではない）。
      const hold = th.noticeMinDurationMs;
      for (const shownAt of [0, 1, 1_000, 60_000]) {
        for (const delta of [-1_000, -1, 0, hold - 1, hold, hold + 1, 100_000]) {
          const gate = timeoutDispatchGateMs(shownAt, shownAt + delta, th);
          if (gate === 0) expect(delta).toBeGreaterThanOrEqual(hold);
        }
      }
    }
  });

  /**
   * 不変条件（下界）: **保持時間を満たしたら必ず 0 を返す**。
   * 上界だけでは「常に null / 常に正の値」で空虚に満たせるので、両側から縛る。
   */
  it('保持時間を満たした入力では必ず 0 になる（空虚に満たされない）', () => {
    for (const requested of [1, 100, 300, 5_000]) {
      const th = clampCallingStageThresholds({ noticeMinDurationMs: requested }, t);
      const hold = th.noticeMinDurationMs;
      for (const shownAt of [0, 1, 1_000, 60_000]) {
        for (const delta of [hold, hold + 1, hold + 10_000]) {
          expect(timeoutDispatchGateMs(shownAt, shownAt + delta, th)).toBe(0);
        }
      }
    }
  });
});
