/**
 * 受付体験メトリクスの計測ロジック (issue #319)。
 *
 * KioskFlow（受付端末フロー）から「ステップ入り・戻る・キャンセル・入力手段」の各イベントを
 * 受け取り、PII を含まない体験メトリクス（{@link ReceptionExperience}）を組み立てる純関数群。
 *
 * I/O・React 依存を持たない（テスト可能な純粋ロジックに閉じる）。KioskFlow はこの tracker を ref で
 * 保持し、各イベントで置き換える（イミュータブル更新）。計測は非破壊で、受付フローの挙動は変えない。
 *
 * PII 最小化: 出力は所要 ms・回数・列挙値のみ。氏名/会社名/メモ等は一切扱わない
 * （.claude/rules/pii-secret-minimization.md）。
 */
import type {
  ExperienceInputMethod,
  ExperienceStep,
  ReceptionExperience,
} from './log';
import type { ReceptionState } from './state';

/** 受付フロー状態 → 体験ステップの写像。ステップでない状態（待機/終端/結果）は null。 */
const STATE_TO_STEP: Partial<Record<ReceptionState, ExperienceStep>> = {
  selectingPurpose: 'selectingPurpose',
  selectingTarget: 'selectingTarget',
  inputVisitorInfo: 'inputVisitorInfo',
  confirming: 'confirming',
  calling: 'calling',
  connected: 'connected',
};

/** 受付フロー状態に対応する体験ステップ（無ければ null）。 */
export function stepForState(state: ReceptionState): ExperienceStep | null {
  return STATE_TO_STEP[state] ?? null;
}

/**
 * 体験メトリクスの計測途中状態（イミュータブル）。
 * `startedAtMs` は最初のステップ入り（＝受付開始）で確定する。
 */
export type ExperienceTracker = {
  readonly startedAtMs: number | null;
  readonly currentStep: ExperienceStep | null;
  readonly stepEnteredAtMs: number | null;
  readonly stepDurations: Readonly<Partial<Record<ExperienceStep, number>>>;
  readonly timeToCallMs: number | null;
  readonly backCount: number;
  readonly cancelCount: number;
  readonly inputMethod: ExperienceInputMethod | null;
};

/** まっさらな tracker を作る（受付開始前）。 */
export function createTracker(): ExperienceTracker {
  return {
    startedAtMs: null,
    currentStep: null,
    stepEnteredAtMs: null,
    stepDurations: {},
    timeToCallMs: null,
    backCount: 0,
    cancelCount: 0,
    inputMethod: null,
  };
}

/**
 * ステップに入ったことを記録する。直前ステップの滞在所要を積算し、最初のステップ入りで
 * 受付開始時刻を確定する。`calling` へ入った時点で受付開始からの所要（timeToCallMs）を記録する。
 */
export function enterStep(
  tracker: ExperienceTracker,
  step: ExperienceStep,
  nowMs: number,
): ExperienceTracker {
  const stepDurations = { ...tracker.stepDurations };
  if (tracker.currentStep !== null && tracker.stepEnteredAtMs !== null) {
    const elapsed = Math.max(0, nowMs - tracker.stepEnteredAtMs);
    stepDurations[tracker.currentStep] = (stepDurations[tracker.currentStep] ?? 0) + elapsed;
  }
  const startedAtMs = tracker.startedAtMs ?? nowMs;
  const timeToCallMs =
    tracker.timeToCallMs ?? (step === 'calling' ? Math.max(0, nowMs - startedAtMs) : null);
  return {
    ...tracker,
    startedAtMs,
    currentStep: step,
    stepEnteredAtMs: nowMs,
    stepDurations,
    timeToCallMs,
  };
}

/** 「戻る」操作を 1 回数える。 */
export function recordBack(tracker: ExperienceTracker): ExperienceTracker {
  return { ...tracker, backCount: tracker.backCount + 1 };
}

/** 「キャンセル」操作を 1 回数える。 */
export function recordCancel(tracker: ExperienceTracker): ExperienceTracker {
  return { ...tracker, cancelCount: tracker.cancelCount + 1 };
}

/** 主入力手段を記録する（後勝ち。明示記録は finalize の既定 touch より優先される）。 */
export function recordInputMethod(
  tracker: ExperienceTracker,
  method: ExperienceInputMethod,
): ExperienceTracker {
  return { ...tracker, inputMethod: method };
}

/**
 * 計測を確定して {@link ReceptionExperience} を組み立てる。
 *
 * - 現在ステップの滞在所要を締める（nowMs まで）。
 * - `abandoned` のときは到達していた最終ステップを `abandonedAtStep` に載せる（完遂時は載せない）。
 * - 入力手段は明示記録が無くても、受付が進行していれば既定で `touch`（タッチファースト端末）。
 * - 0 の回数・空の所要マップは省略する（最小化）。
 */
export function finalizeExperience(
  tracker: ExperienceTracker,
  opts: { abandoned: boolean; nowMs: number },
): ReceptionExperience {
  const progressed = tracker.startedAtMs !== null;
  const stepDurations = { ...tracker.stepDurations };
  if (tracker.currentStep !== null && tracker.stepEnteredAtMs !== null) {
    const elapsed = Math.max(0, opts.nowMs - tracker.stepEnteredAtMs);
    stepDurations[tracker.currentStep] = (stepDurations[tracker.currentStep] ?? 0) + elapsed;
  }

  const exp: ReceptionExperience = {};
  if (Object.keys(stepDurations).length > 0) exp.stepDurations = stepDurations;
  if (tracker.timeToCallMs !== null) exp.timeToCallMs = tracker.timeToCallMs;
  if (tracker.backCount > 0) exp.backCount = tracker.backCount;
  if (tracker.cancelCount > 0) exp.cancelCount = tracker.cancelCount;
  const inputMethod = tracker.inputMethod ?? (progressed ? 'touch' : null);
  if (inputMethod !== null) exp.inputMethod = inputMethod;
  if (opts.abandoned && tracker.currentStep !== null) exp.abandonedAtStep = tracker.currentStep;
  return exp;
}
