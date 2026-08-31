import { describe, expect, it } from 'vitest';
import {
  CALLING_STAGES,
  DEFAULT_CALLING_STAGE_THRESHOLDS,
  clampCallingStageThresholds,
  deriveCallingStage,
  MIN_DIALING_MS,
  MIN_DIALING_FLOOR_MS,
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

  /**
   * 🔴 **結果が確定したら、しきい値を待たずに予告段へ進む** (#832 / #323 AC3)。
   *
   * 予告の目的は「突然感を無くす」ことなので、**サーバが既に結果を返しているのに
   * `noticeAfterMs` まで待つ理由が無い**。むしろ待つと害がある ―― `busy` と `declined`
   * （担当者の辞退）も `timeout` に写る（`call-resolution.ts`）ため、辞退が数秒で確定した
   * 来訪者に「もう少しお待ちください。**担当者に確認しています**」を最大 22 秒、
   * 字幕と読み上げで流し続けることになる。**もう確認していないので、端末が事実でないことを喋る。**
   */
  it('🔴 timeout が確定したら waiting を飛ばして予告段へ進む', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    // 床を越えていれば、noticeAfterMs(25s) を待たずに予告段。
    expect(deriveCallingStage(t.waitingAfterMs, t, { timeoutPending: true })).toBe(
      'preTimeoutNotice',
    );
    expect(deriveCallingStage(t.noticeAfterMs - 1, t, { timeoutPending: true })).toBe(
      'preTimeoutNotice',
    );
  });

  /**
   * 🔴 **床**（#832 2 周目レビュー MAJOR-1）。確定していても、最低限は「呼び出しています」を
   * 見せてから跳ぶ。床が無いと `dialing` が **25〜36ms** に潰れ（実測）、来訪者は「呼ぶ」を
   * 押した瞬間に諦めの予告を見る ―― 端末が呼び出しを試みた痕跡が画面に残らない。
   *
   * さらに悪いのは**音声との乖離**で、ナレーションは段では再発話しないため
   * 「{相手} を呼び出しています」を 3〜4 秒喋り続けている間ずっと、画面は
   * 「つながらない場合は…」を出すことになる（音声とタッチの等価性に反する）。
   */
  it('🔴 確定していても、最低限は dialing を見せてから跳ぶ（床）', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(deriveCallingStage(0, t, { timeoutPending: true })).toBe('dialing');
    expect(deriveCallingStage(MIN_DIALING_MS - 1, t, { timeoutPending: true })).toBe('dialing');
    expect(deriveCallingStage(MIN_DIALING_MS, t, { timeoutPending: true })).toBe('preTimeoutNotice');
  });

  /**
   * 🔴 **床には下限がある**（3 周目レビュー MINOR-4）。`waitingAfterMs` は管理画面で 100ms まで
   * 下げられるが、あの欄の意味は「『お待ちください』へ切り替える経過」であって
   * 「確定後に『呼び出しています』を見せる最低時間」ではない。本番の保証を、意味の違う
   * つまみに消させない。
   */
  it('🔴 テナントが waitingAfterMs を極小にしても床は消えない', () => {
    const t = clampCallingStageThresholds({ waitingAfterMs: 100, noticeAfterMs: 500 });
    expect(deriveCallingStage(MIN_DIALING_FLOOR_MS - 1, t, { timeoutPending: true })).toBe('dialing');
    expect(deriveCallingStage(MIN_DIALING_FLOOR_MS, t, { timeoutPending: true })).toBe(
      'preTimeoutNotice',
    );
  });

  /**
   * 🔴 **床の値そのものを縛る**（3 周目レビュー MAJOR-2）。
   *
   * 上の 2 本は `MIN_DIALING_MS` を**引数にも期待値にも使う自己参照**なので、値を狭める変異
   * （3000 → 250 等）を原理的に検出できない。実測でも `MIN_DIALING_MS = 250` は
   * **unit 6853 本すべてを素通り**した。ここは**リテラル**で下界を置く。
   */
  it('🔴 床は 2.5 秒を下回らない（値を狭める変異を落とす）', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    // 既定しきい値（waitingAfterMs=15s）では clamp が効かないので、床がそのまま出る。
    expect(deriveCallingStage(2_499, t, { timeoutPending: true })).toBe('dialing');
  });

  it('床は waitingAfterMs を超えない（しきい値を縮めれば床も縮む）', () => {
    const t = clampCallingStageThresholds({
      waitingAfterMs: 1_000,
      noticeAfterMs: 5_000,
      noticeMinDurationMs: 100,
    });
    // 床(3s) より waitingAfterMs(1s) が短いので、床は 1s へ縮む（下限 500ms は下回らない）。
    expect(deriveCallingStage(999, t, { timeoutPending: true })).toBe('dialing');
    expect(deriveCallingStage(1_000, t, { timeoutPending: true })).toBe('preTimeoutNotice');
  });

  /**
   * **下界**。「確定したら予告」だけを主張すると、*常に* preTimeoutNotice を返す実装でも通る。
   * 未確定の間は従来どおり段が進むことを対で縛る。
   */
  it('🔴 未確定の間は従来どおり経過で段が進む（下界）', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(deriveCallingStage(0, t, { timeoutPending: false })).toBe('dialing');
    expect(deriveCallingStage(t.waitingAfterMs, t, { timeoutPending: false })).toBe('waiting');
    expect(deriveCallingStage(t.noticeAfterMs, t, { timeoutPending: false })).toBe(
      'preTimeoutNotice',
    );
  });

  it('省略時は未確定として扱う（後方互換）', () => {
    const t = DEFAULT_CALLING_STAGE_THRESHOLDS;
    expect(deriveCallingStage(0, t)).toBe('dialing');
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
   * 「描画を確認せず経過だけで判定する」旧実装の近道が復活したら落ちる。
   * ただし**純関数レベルの拘束**である点に注意 —— KioskFlow の配線が戻された場合は
   * e2e の「レンダラが詰まっても予告は飛ばない」テストが落とす。
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
