/**
 * soak ハーネス（issue #317）の純ロジック。
 *
 * ブラウザ/Playwright に依存しない（DOM も performance も import しない）ため、
 * `npm test`（vitest, unit）で高速に検証できる。実際のブラウザ操作・サンプリングは
 * `tests/e2e/soak/soak-driver.ts` が担い、ここでは「集めたサンプルから合否を判定する」
 * ロジックだけを扱う。
 *
 * モードが長くなるほど閾値を厳しくする（短時間の smoke はノイズを許容し、長時間ほど
 * 微小なリークでも顕在化するため厳しくする）。
 */

export type SoakMode = 'smoke' | '30m' | '2h' | '8h';

export type SoakModeConfig = {
  mode: SoakMode;
  /** ループを回す総時間（ミリ秒）。 */
  totalMs: number;
  /** 何サイクルごとに heap/DOM/heartbeat をサンプリングするか。 */
  sampleIntervalCycles: number;
  /** 何サイクルごとにネットワーク断/タブ非表示の復旧確認を挟むか (#30)。 */
  recoveryIntervalCycles: number;
  /** JS heap 使用量の許容増加率（%）。超過で FAIL。 */
  maxHeapGrowthPercent: number;
  /** heartbeat の許容最大間隔（ミリ秒）。超過は欠落とみなし FAIL。 */
  maxHeartbeatGapMs: number;
};

const DEFAULT_MODE: SoakMode = 'smoke';

/**
 * モード別設定。`smoke` は CI/ローカルで毎回検証できる短時間版（既定・#317 AC）。
 * `30m`/`2h`/`8h` は opt-in（`SOAK_MODE=2h npm run test:soak` 等）で、長時間ほど
 * heap/DOM 増加率の許容を締める。
 */
const MODE_CONFIGS: Record<SoakMode, SoakModeConfig> = {
  smoke: {
    mode: 'smoke',
    totalMs: 2 * 60_000,
    sampleIntervalCycles: 1,
    recoveryIntervalCycles: 2,
    maxHeapGrowthPercent: 80,
    maxHeartbeatGapMs: 90_000,
  },
  '30m': {
    mode: '30m',
    totalMs: 30 * 60_000,
    sampleIntervalCycles: 3,
    recoveryIntervalCycles: 5,
    maxHeapGrowthPercent: 50,
    maxHeartbeatGapMs: 90_000,
  },
  '2h': {
    mode: '2h',
    totalMs: 2 * 60 * 60_000,
    sampleIntervalCycles: 5,
    recoveryIntervalCycles: 10,
    maxHeapGrowthPercent: 35,
    maxHeartbeatGapMs: 90_000,
  },
  '8h': {
    mode: '8h',
    totalMs: 8 * 60 * 60_000,
    sampleIntervalCycles: 5,
    recoveryIntervalCycles: 10,
    maxHeapGrowthPercent: 25,
    maxHeartbeatGapMs: 90_000,
  },
};

/** `SOAK_MODE` env（未指定/不正値は smoke にフォールバック — 誤操作で長時間走らせない）。 */
export function parseSoakMode(raw: string | undefined): SoakModeConfig {
  const key = (raw ?? DEFAULT_MODE) as SoakMode;
  return MODE_CONFIGS[key] ?? MODE_CONFIGS[DEFAULT_MODE];
}

export type MemorySampleLike = {
  timestamp: number;
  /** performance.memory 非対応環境（webkit 等）では null。 */
  usedJSHeapSize: number | null;
  domNodes: number;
};

export type HeartbeatSampleLike = { ok: boolean; timestamp: number };

export type SoakEvalInput = {
  mode: SoakMode;
  memorySamples: MemorySampleLike[];
  heartbeats: HeartbeatSampleLike[];
  consoleErrors: string[];
  expectedHeartbeatIntervalMs: number;
  maxHeapGrowthPercent: number;
  /** 未指定なら maxHeapGrowthPercent と同じ許容率を使う。 */
  maxDomNodeGrowthPercent?: number;
};

export type SoakEvalResult = {
  passed: boolean;
  reasons: string[];
  heapGrowthPercent: number | null;
  domGrowthPercent: number | null;
  maxHeartbeatGapMs: number | null;
};

/** 起動直後のロード揺らぎをノイズとして除外するため、先頭 N 点はベースライン計算から外す。 */
const WARMUP_SAMPLES_TO_SKIP = 1;

function trimWarmup<T>(samples: T[]): T[] {
  return samples.length > WARMUP_SAMPLES_TO_SKIP + 1 ? samples.slice(WARMUP_SAMPLES_TO_SKIP) : samples;
}

/** JS heap 使用量の増加率（%）。判定に十分なサンプルが無ければ null（判定不能・非 FAIL）。 */
export function evaluateHeapGrowth(samples: MemorySampleLike[]): number | null {
  const usable = samples.filter(
    (s): s is MemorySampleLike & { usedJSHeapSize: number } => typeof s.usedJSHeapSize === 'number',
  );
  const trimmed = trimWarmup(usable);
  const first = trimmed[0];
  const lastSample = trimmed[trimmed.length - 1];
  if (trimmed.length < 2 || !first || !lastSample) return null;
  const baseline = first.usedJSHeapSize;
  const last = lastSample.usedJSHeapSize;
  if (baseline <= 0) return null;
  return ((last - baseline) / baseline) * 100;
}

/** DOM ノード数の増加率（%）。ロジックは heap と同じ（デタッチノードの堆積検知）。 */
export function evaluateDomNodeGrowth(samples: MemorySampleLike[]): number | null {
  const trimmed = trimWarmup(samples);
  const first = trimmed[0];
  const lastSample = trimmed[trimmed.length - 1];
  if (trimmed.length < 2 || !first || !lastSample) return null;
  const baseline = first.domNodes;
  const last = lastSample.domNodes;
  if (baseline <= 0) return null;
  return ((last - baseline) / baseline) * 100;
}

/**
 * heartbeat の最大欠落間隔（ミリ秒）。直近の成功時刻からの経過として計算するため、
 * 失敗が連続しても「最後に成功していた時刻」からの空白として捕捉できる。
 * サンプルが無ければ null（判定不能）。一度も成功していなければ Infinity（必ず FAIL させる）。
 */
export function maxHeartbeatGap(heartbeats: HeartbeatSampleLike[]): number | null {
  if (heartbeats.length === 0) return null;
  const sorted = [...heartbeats].sort((a, b) => a.timestamp - b.timestamp);
  let lastOk: number | null = null;
  let max = 0;
  for (const hb of sorted) {
    if (hb.ok) {
      if (lastOk !== null) max = Math.max(max, hb.timestamp - lastOk);
      lastOk = hb.timestamp;
    } else if (lastOk !== null) {
      max = Math.max(max, hb.timestamp - lastOk);
    }
  }
  return lastOk === null ? Infinity : max;
}

/** サンプル群から合否を判定する。reasons が空なら passed=true。 */
export function evaluateSoakRun(input: SoakEvalInput): SoakEvalResult {
  const reasons: string[] = [];

  if (input.consoleErrors.length > 0) {
    reasons.push(
      `console エラーが ${input.consoleErrors.length} 件検出された: ${input.consoleErrors.slice(0, 3).join(' / ')}`,
    );
  }

  const heapGrowthPercent = evaluateHeapGrowth(input.memorySamples);
  if (heapGrowthPercent !== null && heapGrowthPercent > input.maxHeapGrowthPercent) {
    reasons.push(
      `JS heap 増加率 ${heapGrowthPercent.toFixed(1)}% が閾値 ${input.maxHeapGrowthPercent}% を超過（リーク疑い）`,
    );
  }

  const domGrowthPercent = evaluateDomNodeGrowth(input.memorySamples);
  const maxDomGrowthPercent = input.maxDomNodeGrowthPercent ?? input.maxHeapGrowthPercent;
  if (domGrowthPercent !== null && domGrowthPercent > maxDomGrowthPercent) {
    reasons.push(
      `DOM ノード数増加率 ${domGrowthPercent.toFixed(1)}% が閾値 ${maxDomGrowthPercent}% を超過（デタッチノード堆積疑い）`,
    );
  }

  const gap = maxHeartbeatGap(input.heartbeats);
  if (gap === Infinity) {
    reasons.push('heartbeat が一度も成功しなかった');
  } else if (gap !== null && gap > input.expectedHeartbeatIntervalMs) {
    reasons.push(`heartbeat の最大間隔 ${gap}ms が閾値 ${input.expectedHeartbeatIntervalMs}ms を超過（欠落の疑い）`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    heapGrowthPercent,
    domGrowthPercent,
    maxHeartbeatGapMs: gap,
  };
}
