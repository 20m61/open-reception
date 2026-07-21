/**
 * 音声評価の指標（純関数） (issue #365)。
 *
 * `evaluation-events.ts` の共通イベント列 + 正解ラベルから、精度 / 遅延 / ターン / 割り込み /
 * Entity 解決 / 信頼性の指標を算出する。ブラウザ・AWS・実音声に一切依存しないので `npm test` で回る。
 *
 * 設計上の約束:
 * - **計測できなかった指標は `null`**。0 や 1 に丸めない。分母 0 を「満点」として緑にしてしまうと、
 *   計測が壊れた回帰を検知できなくなる（SLO 判定側は null を skipped、strict では違反として扱う）。
 * - セッション指標は生サンプルと分子分母を保持する。スイート集計はそれらを足し合わせてから
 *   割合とパーセンタイルを取り直す（セッションごとの割合を平均すると重み付けが狂うため）。
 * - 割り込みの「停止の原因」は `attributeBargeInStops` **1 箇所だけ**で決める。遅延と誤停止率が
 *   別々の規則で帰属していると、指標同士が矛盾する。
 */
import {
  observedNearEndOnsets,
  playbackWindows,
  sortVoiceEvalEvents,
  type VoiceEvalEvent,
  type VoiceEvalNearEndObservation,
  type VoiceEvalNearEndStimulus,
  type VoiceEvalPlaybackWindow,
  type VoiceEvalSession,
  type VoiceEvalTurnGroundTruth,
} from './evaluation-events';

// ---------------------------------------------------------------------------
// 統計の土台
// ---------------------------------------------------------------------------

/** 線形補間パーセンタイル。サンプルが無ければ null（判定不能）。`p` は 0–100 にクランプする。 */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const clamped = Math.min(100, Math.max(0, p));
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const rank = ((sorted.length - 1) * clamped) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

export type LatencySummary = {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
};

export function latencySummary(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null, mean: null };
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    mean: samples.reduce((sum, v) => sum + v, 0) / samples.length,
  };
}

/** 分母 0 は null（「該当例が無い」を「満点」と混同しない）。 */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

// ---------------------------------------------------------------------------
// 文字誤り率
// ---------------------------------------------------------------------------

/**
 * 空白の揺れ（半角/全角/連続）を正規化する。読み上げ・書き起こしの区切り方の差を
 * 誤りとして数えないため。文字種の正規化（カタカナ↔ひらがな等）は **行わない** ——
 * 同音異字の取り違えは #365 が数えたい誤りそのもの。
 */
function normalizeForCer(text: string): string {
  return text.replace(/[\s　]+/gu, '');
}

/** 文字単位の Levenshtein 距離。日本語のためコードポイント単位で比較する。 */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 編集距離と正解文字数。コーパス全体の CER を後から復元できるよう、分子分母のまま返す。 */
export function characterErrorCounts(
  reference: string,
  hypothesis: string,
): { distance: number; referenceLength: number } {
  const ref = [...normalizeForCer(reference)];
  const hyp = [...normalizeForCer(hypothesis)];
  return { distance: levenshtein(ref, hyp), referenceLength: ref.length };
}

/**
 * 文字誤り率 (CER) = (置換 + 挿入 + 削除) / 正解文字数。
 * 正解が空で仮説が空でなければ 1（0 除算を無限大にしない）。両方空なら 0。
 */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const { distance, referenceLength } = characterErrorCounts(reference, hypothesis);
  if (referenceLength === 0) return distance === 0 ? 0 : 1;
  return distance / referenceLength;
}

// ---------------------------------------------------------------------------
// 割り込みの帰属（遅延と誤停止率で共有する唯一の規則）
// ---------------------------------------------------------------------------

export type BargeInAttribution = {
  observationIndex: number;
  t: number;
  /** この観測が再生停止を引き起こしたと見なせるか。 */
  stopped: boolean;
  /** 引き起こした場合の onset → 停止の遅延。 */
  stopLatencyMs: number | null;
};

/**
 * 停止判断に最低限かかる時間。これより停止に近い onset は、物理的に原因ではありえない
 * （その onset を検出して止めるには間に合わない）。
 */
export const MIN_BARGE_IN_REACTION_MS = 30;

/**
 * 停止判断に許される最大の時間。これより古い onset は原因とみなさない —— その onset で止める
 * つもりなら、とっくに止まっていたはずだから。
 *
 * 値は uat の停止遅延 SLO（P50 150ms / P95 300ms）より広く取ってある。SLO を満たす provider の
 * 停止は必ず窓に入る。逆に窓より遅い停止は**原因不明として帰属しない**（該当の割り込みは
 * 「検出できなかった」として数えられる）。ただし**停止そのものは捨てない** ——
 * {@link unattributedBargeInStops} が悲観的な遅延見積りと件数を残す。捨てると、検出率の余裕に
 * 吸収されてどれだけ遅い停止でもゲートが緑になる。
 */
export const MAX_BARGE_IN_REACTION_MS = 400;

/** 再生区間の同一性キー。`observedNearEndOnsets` が返す window とは別インスタンスになるため。 */
function windowKey(window: VoiceEvalPlaybackWindow): string {
  return `${window.start}:${window.stop}`;
}

/** 区間ごとに原因とみなせる onset を 1 つだけ選ぶ（帰属の唯一の実装）。 */
function bargeInCauses(events: readonly VoiceEvalEvent[]): {
  observations: VoiceEvalNearEndObservation[];
  causeOfWindow: Map<string, number>;
} {
  const observations = observedNearEndOnsets(events);
  // observations は時刻順なので、窓に入る最初のものがそのまま「最も早い原因」になる。
  const causeOfWindow = new Map<string, number>();
  for (const observation of observations) {
    const { window } = observation;
    if (window.reason !== 'barge_in') continue;
    const reaction = window.stop - observation.t;
    if (reaction < MIN_BARGE_IN_REACTION_MS || reaction > MAX_BARGE_IN_REACTION_MS) continue;
    const key = windowKey(window);
    if (!causeOfWindow.has(key)) causeOfWindow.set(key, observation.observationIndex);
  }
  return { observations, causeOfWindow };
}

/**
 * 再生停止の原因を近端 onset へ帰属させる。
 *
 * 規則: `barge_in` で終わった再生区間について、停止までの間隔が
 * **`MIN_BARGE_IN_REACTION_MS` 以上 `MAX_BARGE_IN_REACTION_MS` 以下**の onset のうち
 * **最も早いもの**を原因とみなす。
 *
 * 片側だけの窓ではどちらの向きも誤る（実測で確認した誤ラベル）:
 * - 「区間の最初」だと、相づちの 400ms 後に本当の割り込みが来て停止した系列で相づちが原因にされる。
 * - 「停止より前で最も遅いもの」だと、割り込み(1000ms) → 相づち(1060ms) → 停止(1120ms) の系列で
 *   相づちが原因にされ、割り込みは未検出、さらに遅延が 120ms ではなく 60ms と**半分に過小評価**される。
 * 両端で挟んで最も早いものを採ると、どちらの系列も正しく解ける。
 *
 * 遅延指標と誤停止率の**両方がこの関数だけを使う**。別々の規則で帰属すると、指標同士が矛盾し、
 * 「割り込みは未検出なのに、後続の相づちが誤停止として数えられる」といった両方向の誤ラベルが起きる。
 */
export function attributeBargeInStops(events: readonly VoiceEvalEvent[]): BargeInAttribution[] {
  const { observations, causeOfWindow } = bargeInCauses(events);

  return observations.map((observation) => {
    const causedStop = causeOfWindow.get(windowKey(observation.window)) === observation.observationIndex;
    return {
      observationIndex: observation.observationIndex,
      t: observation.t,
      stopped: causedStop,
      stopLatencyMs: causedStop ? observation.window.stop - observation.t : null,
    };
  });
}

/** 原因の onset を特定できなかった `barge_in` 停止。 */
export type UnattributedBargeInStop = {
  /** 停止時刻。 */
  stop: number;
  /**
   * 悲観的な遅延の見積り = 停止から**最も早い候補 onset**（`MIN_BARGE_IN_REACTION_MS` 以上前）
   * までの間隔。候補が 1 つも無ければ `null`（近端発話なしで止まった = 測りようがない）。
   */
  pessimisticStopLatencyMs: number | null;
};

/**
 * 帰属できなかった `barge_in` 停止を列挙する。
 *
 * **停止を無かったことにしてはいけない。** 反応窓（{@link MAX_BARGE_IN_REACTION_MS}）より遅い停止の
 * サンプルを捨てると、その割り込みは単に「検出漏れ」1 件になり、`minTrueInterruptionDetectionRate` の
 * 余裕（ci で 10%・uat で 2%）に吸収されて **どれだけ遅い停止でもゲートが緑になる**。実測でも
 * 「9 件が 120ms + 1 件が 2000ms」のスイートが検出率 0.9（下限ちょうど）で PASS していた。
 *
 * そこで、遅延は**最も早い候補からの経過**（= 取りうる最大の見積り）として悲観的に積み、
 * 件数は `unattributedStopRate` として独自の SLO で罰する。原因の onset を「たぶんこれ」と
 * 決め打ちしないので、誤停止率・検出率が楽観方向に動くこともない。
 */
export function unattributedBargeInStops(events: readonly VoiceEvalEvent[]): UnattributedBargeInStop[] {
  const { observations, causeOfWindow } = bargeInCauses(events);

  return playbackWindows(events)
    .filter((window) => window.reason === 'barge_in' && !causeOfWindow.has(windowKey(window)))
    .map((window) => {
      const key = windowKey(window);
      const earliest = observations.find(
        (o) => windowKey(o.window) === key && window.stop - o.t >= MIN_BARGE_IN_REACTION_MS,
      );
      return {
        stop: window.stop,
        pessimisticStopLatencyMs: earliest ? window.stop - earliest.t : null,
      };
    });
}

export type NearEndMatch = {
  stimulus: VoiceEvalNearEndStimulus;
  /** 刺激に対応する観測。検出漏れなら null。 */
  observation: VoiceEvalNearEndObservation | null;
  /** 観測が再生停止を引き起こしたか（検出漏れなら false）。 */
  stopped: boolean;
};

export type NearEndMatching = {
  matches: NearEndMatch[];
  /** どの刺激にも対応しない観測 = 誤検出。 */
  spuriousObservations: VoiceEvalNearEndObservation[];
};

/** 割り当ての良さ。件数を最大化し、同数なら距離の総和が小さい方を選ぶ。 */
type AssignmentScore = { count: number; distance: number };

function isBetterAssignment(candidate: AssignmentScore, incumbent: AssignmentScore): boolean {
  return candidate.count !== incumbent.count ? candidate.count > incumbent.count : candidate.distance < incumbent.distance;
}

type AssignmentMove = 'match' | 'skip-stimulus' | 'skip-observation';

/**
 * 刺激と観測の**大域最適**な対応を求める（貪欲法ではない）。
 *
 * 時刻順に並んだ 2 列の対応なので、交差しない割り当てだけを考えれば十分で、O(刺激 × 観測) の
 * DP で厳密解が出る（許容窓が互いに重ならない限り、最適解は必ず交差しない。重なりは
 * `validateVoiceEvalSession` が構造的に弾く）。
 */
function assignObservationsToStimuli(
  stimuli: readonly VoiceEvalNearEndStimulus[],
  tolerances: readonly number[],
  observations: readonly VoiceEvalNearEndObservation[],
): (VoiceEvalNearEndObservation | null)[] {
  const stimulusCount = stimuli.length;
  const observationCount = observations.length;
  const empty: AssignmentScore = { count: 0, distance: 0 };
  // best[i][j] = 刺激 i 以降と観測 j 以降を対応付けたときの最良スコア。末尾行/列は「残りは全て
  // 検出漏れ / 誤検出」で 0 件。
  const best: AssignmentScore[][] = Array.from({ length: stimulusCount + 1 }, () =>
    Array.from({ length: observationCount + 1 }, () => empty),
  );
  const move: AssignmentMove[][] = Array.from({ length: stimulusCount }, () =>
    Array.from({ length: observationCount }, () => 'skip-stimulus' as AssignmentMove),
  );

  for (let i = stimulusCount - 1; i >= 0; i -= 1) {
    for (let j = observationCount - 1; j >= 0; j -= 1) {
      const stimulus = stimuli[i]!;
      const observation = observations[j]!;
      const distance = Math.abs(observation.t - stimulus.atMs);
      const paired = best[i + 1]![j + 1]!;

      // 同点なら「対応付ける」「早い観測を使う」を優先する（決定論的にするため）。
      const candidates: { score: AssignmentScore; move: AssignmentMove }[] = [];
      if (distance <= (tolerances[i] ?? stimulus.toleranceMs)) {
        candidates.push({ score: { count: paired.count + 1, distance: paired.distance + distance }, move: 'match' });
      }
      candidates.push({ score: best[i + 1]![j]!, move: 'skip-stimulus' });
      candidates.push({ score: best[i]![j + 1]!, move: 'skip-observation' });
      const winner = candidates.reduce((acc, c) => (isBetterAssignment(c.score, acc.score) ? c : acc));

      best[i]![j] = winner.score;
      move[i]![j] = winner.move;
    }
  }

  const assigned: (VoiceEvalNearEndObservation | null)[] = stimuli.map(() => null);
  let i = 0;
  let j = 0;
  while (i < stimulusCount && j < observationCount) {
    const step = move[i]![j]!;
    if (step === 'match') {
      assigned[i] = observations[j]!;
      i += 1;
      j += 1;
    } else if (step === 'skip-stimulus') {
      i += 1;
    } else {
      j += 1;
    }
  }
  return assigned;
}

/**
 * 隣接する刺激の許容窓が重なっている場合に、重ならない幅まで縮めた実効許容幅を返す。
 *
 * 重なる正解は `validateVoiceEvalSession` が弾くが、`matchNearEnd` は export されていて
 * バリデータを通さずに呼べる。窓が重なったまま解くと、DP が交差しない解しか出せないぶん
 * 対応件数が劣化しうる（= 検出漏れを水増しする）。縮めておけば、どんな入力でも
 * 「1 観測が高々 1 刺激の窓に入る」が保たれ、DP が厳密解になる。
 */
function disjointTolerances(stimuli: readonly VoiceEvalNearEndStimulus[]): number[] {
  return stimuli.map((stimulus, index) => {
    const neighbours = [stimuli[index - 1], stimuli[index + 1]].filter((s) => s !== undefined);
    const halfGaps = neighbours.map((neighbour) => Math.abs(stimulus.atMs - neighbour.atMs) / 2);
    return Math.min(stimulus.toleranceMs, ...halfGaps);
  });
}

/**
 * 刺激（正解）と観測 onset を時間窓でマッチングする。
 * 未マッチの刺激 = 検出漏れ、未マッチの観測 = 誤検出として、**どちらも計測可能**にする。
 *
 * 割り当ては大域最適（件数最大 → 総距離最小）で行う。**刺激順の貪欲法は使わない**:
 * 許容窓が刺激間隔以上に広いと先行する刺激が後続刺激の観測を横取りし、相づちの onset を
 * 取りこぼしただけの provider が「割り込み未検出 + 相づち誤停止」という**逆向きの誤ラベル**で
 * 採点される（刺激 1540/1940ms・許容窓 400ms の同梱データセットで実際に再現した）。
 */
export function matchNearEnd(session: VoiceEvalSession): NearEndMatching {
  const observations = observedNearEndOnsets(session.events);
  const attributions = new Map(attributeBargeInStops(session.events).map((a) => [a.observationIndex, a]));
  const stimuli = [...session.groundTruth.nearEndStimuli].sort((a, b) => a.atMs - b.atMs);
  const assigned = assignObservationsToStimuli(stimuli, disjointTolerances(stimuli), observations);
  const used = new Set(assigned.filter((o) => o !== null).map((o) => o.observationIndex));

  const matches: NearEndMatch[] = stimuli.map((stimulus, index) => {
    const observation = assigned[index] ?? null;
    return {
      stimulus,
      observation,
      stopped: observation ? (attributions.get(observation.observationIndex)?.stopped ?? false) : false,
    };
  });

  return {
    matches,
    spuriousObservations: observations.filter((o) => !used.has(o.observationIndex)),
  };
}

// ---------------------------------------------------------------------------
// 遅延
// ---------------------------------------------------------------------------

export const LATENCY_KEYS = [
  'audioOnsetToFirstPartial',
  'audioOnsetToStablePartial',
  'speechEndToTurnCommitted',
  'turnCommittedToFirstAudio',
  'ttsRequestToFirstByte',
  'speechEndToFirstAudio',
  'speechEndToFirstAudioShortAnswer',
  'speechEndToFirstAudioFreeForm',
  'nearEndOnsetToPlaybackStopped',
  'visemeSyncError',
] as const;

export type LatencyKey = (typeof LATENCY_KEYS)[number];
export type LatencySamples = Record<LatencyKey, number[]>;
export type LatencyMetrics = Record<LatencyKey, LatencySummary>;

function emptySamples(): LatencySamples {
  return Object.fromEntries(LATENCY_KEYS.map((key) => [key, [] as number[]])) as LatencySamples;
}

function eventsByTurn(events: readonly VoiceEvalEvent[]): Map<number, VoiceEvalEvent[]> {
  const byTurn = new Map<number, VoiceEvalEvent[]>();
  for (const event of sortVoiceEvalEvents(events)) {
    const bucket = byTurn.get(event.turnIndex) ?? [];
    bucket.push(event);
    byTurn.set(event.turnIndex, bucket);
  }
  return byTurn;
}

function firstOf<T extends VoiceEvalEvent['type']>(
  events: readonly VoiceEvalEvent[],
  type: T,
): Extract<VoiceEvalEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<VoiceEvalEvent, { type: T }> | undefined;
}

/** イベント列から遅延の生サンプルを取り出す。対応する起点/終点が無いターンはサンプルを作らない。 */
export function computeLatencySamples(session: VoiceEvalSession): LatencySamples {
  const samples = emptySamples();
  const groundTruthByTurn = new Map(session.groundTruth.turns.map((t) => [t.turnIndex, t]));

  for (const [turnIndex, events] of eventsByTurn(session.events)) {
    const onset = firstOf(events, 'audio.onset');
    const firstPartial = events.find((e) => e.type === 'stt.partial');
    const stablePartial = events.find((e) => e.type === 'stt.partial' && e.stable);
    const speechEnd = firstOf(events, 'speech.end');
    const committed = firstOf(events, 'turn.committed');
    const ttsRequest = firstOf(events, 'tts.request');
    const firstByte = firstOf(events, 'tts.first_byte');
    const playbackStart = firstOf(events, 'tts.playback_start');

    if (onset && firstPartial) samples.audioOnsetToFirstPartial.push(firstPartial.t - onset.t);
    if (onset && stablePartial) samples.audioOnsetToStablePartial.push(stablePartial.t - onset.t);
    if (speechEnd && committed) samples.speechEndToTurnCommitted.push(committed.t - speechEnd.t);
    if (committed && playbackStart) samples.turnCommittedToFirstAudio.push(playbackStart.t - committed.t);
    if (ttsRequest && firstByte) samples.ttsRequestToFirstByte.push(firstByte.t - ttsRequest.t);

    if (speechEnd && playbackStart) {
      const latency = playbackStart.t - speechEnd.t;
      samples.speechEndToFirstAudio.push(latency);
      const kind = groundTruthByTurn.get(turnIndex)?.utteranceKind;
      if (kind === 'short_answer') samples.speechEndToFirstAudioShortAnswer.push(latency);
      if (kind === 'free_form') samples.speechEndToFirstAudioFreeForm.push(latency);
    }

    // viseme は playback_start + 音声内タイムスタンプに適用されるべき。ずれの絶対値を誤差とする。
    if (playbackStart) {
      for (const event of events) {
        if (event.type !== 'vrm.viseme_applied') continue;
        samples.visemeSyncError.push(Math.abs(event.t - (playbackStart.t + event.audioTimestampMs)));
      }
    }
  }

  // 割り込み応答は、停止を**引き起こした**onset のみを標本にする（帰属は共有関数に委譲）。
  // 窓内の全 onset を積むと、停止を起こしていない相づちが小さい値を寄与して p50/p95 を楽観方向に歪める。
  for (const attribution of attributeBargeInStops(session.events)) {
    if (attribution.stopLatencyMs !== null) samples.nearEndOnsetToPlaybackStopped.push(attribution.stopLatencyMs);
  }
  // 帰属できなかった停止も、悲観的な見積りで必ず標本に入れる（捨てると遅い停止が SLO をすり抜ける）。
  for (const stop of unattributedBargeInStops(session.events)) {
    if (stop.pessimisticStopLatencyMs !== null) samples.nearEndOnsetToPlaybackStopped.push(stop.pessimisticStopLatencyMs);
  }

  return samples;
}

export function summarizeLatency(samples: LatencySamples): LatencyMetrics {
  return Object.fromEntries(LATENCY_KEYS.map((key) => [key, latencySummary(samples[key])])) as LatencyMetrics;
}

export function computeLatencyMetrics(session: VoiceEvalSession): LatencyMetrics {
  return summarizeLatency(computeLatencySamples(session));
}

// ---------------------------------------------------------------------------
// STT / 固有名詞
// ---------------------------------------------------------------------------

export type SttCounts = {
  cerSamples: number[];
  /** コーパス全体の CER を復元するための分子分母（発話ごとの CER の平均とは別物）。 */
  editDistanceTotal: number;
  referenceCharTotal: number;
  personNameMatches: number;
  personNameTotal: number;
  departmentNameMatches: number;
  departmentNameTotal: number;
};

export type SttMetrics = {
  /** 発話ごとの CER の分布。 */
  cer: LatencySummary;
  /** コーパス CER = 総編集距離 / 総正解文字数。長い発話が正しく重み付けされる。 */
  corpusCer: number | null;
  /**
   * 人名の包含一致率。正解表記が `stt.final` にそのまま現れたかを見る（CER とは独立）。
   * 既知の限界: 部分文字列一致のため「田中」は「田中村」にもマッチする。
   */
  personNameExactMatchRate: number | null;
  departmentNameExactMatchRate: number | null;
};

function finalTextForTurn(session: VoiceEvalSession, turnIndex: number): string | undefined {
  const events = eventsByTurn(session.events).get(turnIndex) ?? [];
  return firstOf(events, 'stt.final')?.text;
}

/** 正解の固有名詞が全て書き起こしに現れているか（包含一致。上記の限界に注意）。 */
function containsAllNames(hypothesis: string, expected: readonly string[]): boolean {
  const normalized = normalizeForCer(hypothesis);
  return expected.every((name) => normalized.includes(normalizeForCer(name)));
}

export function computeSttCounts(session: VoiceEvalSession): SttCounts {
  const counts: SttCounts = {
    cerSamples: [],
    editDistanceTotal: 0,
    referenceCharTotal: 0,
    personNameMatches: 0,
    personNameTotal: 0,
    departmentNameMatches: 0,
    departmentNameTotal: 0,
  };

  for (const turn of session.groundTruth.turns) {
    const hypothesis = finalTextForTurn(session, turn.turnIndex);
    if (hypothesis === undefined) continue;

    counts.cerSamples.push(characterErrorRate(turn.referenceTranscript, hypothesis));
    const { distance, referenceLength } = characterErrorCounts(turn.referenceTranscript, hypothesis);
    counts.editDistanceTotal += distance;
    counts.referenceCharTotal += referenceLength;

    if (turn.expectedPersonNames?.length) {
      counts.personNameTotal += 1;
      if (containsAllNames(hypothesis, turn.expectedPersonNames)) counts.personNameMatches += 1;
    }
    if (turn.expectedDepartmentNames?.length) {
      counts.departmentNameTotal += 1;
      if (containsAllNames(hypothesis, turn.expectedDepartmentNames)) counts.departmentNameMatches += 1;
    }
  }

  return counts;
}

export function summarizeStt(counts: SttCounts): SttMetrics {
  return {
    cer: latencySummary(counts.cerSamples),
    corpusCer: ratio(counts.editDistanceTotal, counts.referenceCharTotal),
    personNameExactMatchRate: ratio(counts.personNameMatches, counts.personNameTotal),
    departmentNameExactMatchRate: ratio(counts.departmentNameMatches, counts.departmentNameTotal),
  };
}

export function computeSttMetrics(session: VoiceEvalSession): SttMetrics {
  return summarizeStt(computeSttCounts(session));
}

// ---------------------------------------------------------------------------
// ターン
// ---------------------------------------------------------------------------

export type TurnCounts = {
  falseCommits: number;
  shouldNotCommitTotal: number;
  missedEnds: number;
  shouldCommitTotal: number;
  fillerFalseResponses: number;
  fillerTotal: number;
};

export type TurnMetrics = {
  /** 誤終了率: 切ってはいけないターンを確定してしまった割合。 */
  falseCommitRate: number | null;
  /** 終了見逃し率: 確定すべきターンを確定できなかった割合。 */
  missedEndRate: number | null;
  /** フィラー・接続助詞で終わる発話を切ってしまった割合。 */
  fillerFalseResponseRate: number | null;
};

function didCommit(session: VoiceEvalSession, turn: VoiceEvalTurnGroundTruth): boolean {
  const events = eventsByTurn(session.events).get(turn.turnIndex) ?? [];
  return events.some((e) => e.type === 'turn.committed');
}

export function computeTurnCounts(session: VoiceEvalSession): TurnCounts {
  const counts: TurnCounts = {
    falseCommits: 0,
    shouldNotCommitTotal: 0,
    missedEnds: 0,
    shouldCommitTotal: 0,
    fillerFalseResponses: 0,
    fillerTotal: 0,
  };

  for (const turn of session.groundTruth.turns) {
    const committed = didCommit(session, turn);
    if (turn.shouldCommit) {
      counts.shouldCommitTotal += 1;
      if (!committed) counts.missedEnds += 1;
    } else {
      counts.shouldNotCommitTotal += 1;
      if (committed) counts.falseCommits += 1;
      // フィラー起因の誤応答は「切ってはいけないフィラー発話」を母数にする。
      if (turn.endsWithFiller) {
        counts.fillerTotal += 1;
        if (committed) counts.fillerFalseResponses += 1;
      }
    }
  }

  return counts;
}

export function summarizeTurn(counts: TurnCounts): TurnMetrics {
  return {
    falseCommitRate: ratio(counts.falseCommits, counts.shouldNotCommitTotal),
    missedEndRate: ratio(counts.missedEnds, counts.shouldCommitTotal),
    fillerFalseResponseRate: ratio(counts.fillerFalseResponses, counts.fillerTotal),
  };
}

export function computeTurnMetrics(session: VoiceEvalSession): TurnMetrics {
  return summarizeTurn(computeTurnCounts(session));
}

// ---------------------------------------------------------------------------
// 割り込み
// ---------------------------------------------------------------------------

export type BargeInCounts = {
  interruptionStopped: number;
  interruptionTotal: number;
  backchannelStopped: number;
  backchannelTotal: number;
  echoStopped: number;
  echoTotal: number;
  nonInterruptionStopped: number;
  nonInterruptionTotal: number;
  /** 刺激のうち onset として観測できた件数（VAD の検出漏れを測る）。 */
  detectedStimuli: number;
  stimuliTotal: number;
  /** どの刺激にも対応しない観測 = 誤検出。 */
  spuriousObservations: number;
  /** `barge_in` で終わった再生区間の総数と、そのうち原因を特定できなかった件数。 */
  bargeInStops: number;
  unattributedStops: number;
};

export type BargeInMetrics = {
  /** 真の割り込みを検出して再生を止められた割合。 */
  trueInterruptionDetectionRate: number | null;
  /** 相づちで誤って止めた割合。 */
  backchannelFalseStopRate: number | null;
  /** 自己音声エコーで誤って止めた割合。 */
  echoFalseStopRate: number | null;
  /** 割り込み以外の近端発話全体での誤停止率（SLO の「誤割り込み率」）。 */
  falseStopRate: number | null;
  /** 近端発話そのものを onset として拾えた割合。 */
  nearEndOnsetDetectionRate: number | null;
  spuriousNearEndOnsetCount: number;
  /**
   * `barge_in` 停止のうち、原因の onset を特定できなかった割合。反応窓より遅い停止と、
   * 近端発話が無いのに止まった停止を捕まえる。「停止したのに理由が言えない」は計測の穴なので、
   * 遅延の分布に埋もれさせず独立した指標にする。
   */
  unattributedStopRate: number | null;
  unattributedStopCount: number;
};

export function computeBargeInCounts(session: VoiceEvalSession): BargeInCounts {
  const counts: BargeInCounts = {
    interruptionStopped: 0,
    interruptionTotal: 0,
    backchannelStopped: 0,
    backchannelTotal: 0,
    echoStopped: 0,
    echoTotal: 0,
    nonInterruptionStopped: 0,
    nonInterruptionTotal: 0,
    detectedStimuli: 0,
    stimuliTotal: 0,
    spuriousObservations: 0,
    bargeInStops: 0,
    unattributedStops: 0,
  };

  const { matches, spuriousObservations } = matchNearEnd(session);
  counts.spuriousObservations = spuriousObservations.length;
  counts.bargeInStops = playbackWindows(session.events).filter((w) => w.reason === 'barge_in').length;
  counts.unattributedStops = unattributedBargeInStops(session.events).length;

  for (const match of matches) {
    counts.stimuliTotal += 1;
    if (match.observation) counts.detectedStimuli += 1;

    if (match.stimulus.label === 'interruption') {
      counts.interruptionTotal += 1;
      // 検出漏れは「止められなかった」。fatal ではなく検出率の低下として現れる。
      if (match.stopped) counts.interruptionStopped += 1;
      continue;
    }

    counts.nonInterruptionTotal += 1;
    if (match.stopped) counts.nonInterruptionStopped += 1;
    if (match.stimulus.label === 'backchannel') {
      counts.backchannelTotal += 1;
      if (match.stopped) counts.backchannelStopped += 1;
    }
    if (match.stimulus.label === 'echo') {
      counts.echoTotal += 1;
      if (match.stopped) counts.echoStopped += 1;
    }
  }

  return counts;
}

export function summarizeBargeIn(counts: BargeInCounts): BargeInMetrics {
  return {
    trueInterruptionDetectionRate: ratio(counts.interruptionStopped, counts.interruptionTotal),
    backchannelFalseStopRate: ratio(counts.backchannelStopped, counts.backchannelTotal),
    echoFalseStopRate: ratio(counts.echoStopped, counts.echoTotal),
    falseStopRate: ratio(counts.nonInterruptionStopped, counts.nonInterruptionTotal),
    nearEndOnsetDetectionRate: ratio(counts.detectedStimuli, counts.stimuliTotal),
    spuriousNearEndOnsetCount: counts.spuriousObservations,
    unattributedStopRate: ratio(counts.unattributedStops, counts.bargeInStops),
    unattributedStopCount: counts.unattributedStops,
  };
}

export function computeBargeInMetrics(session: VoiceEvalSession): BargeInMetrics {
  return summarizeBargeIn(computeBargeInCounts(session));
}

// ---------------------------------------------------------------------------
// Entity 解決
// ---------------------------------------------------------------------------

export type EntityCounts = {
  top1Hits: number;
  top3Hits: number;
  annotatedTurns: number;
  relevantRetrieved: number;
  expectedTotal: number;
  retrievedTotal: number;
};

export type EntityMetrics = {
  top1Rate: number | null;
  top3Rate: number | null;
  recall: number | null;
  precision: number | null;
};

export function computeEntityCounts(session: VoiceEvalSession): EntityCounts {
  const counts: EntityCounts = {
    top1Hits: 0,
    top3Hits: 0,
    annotatedTurns: 0,
    relevantRetrieved: 0,
    expectedTotal: 0,
    retrievedTotal: 0,
  };
  const byTurn = eventsByTurn(session.events);

  for (const turn of session.groundTruth.turns) {
    const expected = turn.expectedEntityIds;
    if (!expected?.length) continue;

    counts.annotatedTurns += 1;
    counts.expectedTotal += expected.length;

    // 解決イベントが無いターンは Top1/Top3 の取りこぼしとして数える（欠測を無視して率を上げない）。
    const resolved = firstOf(byTurn.get(turn.turnIndex) ?? [], 'entity.resolved');
    if (!resolved) continue;

    const candidates = resolved.candidates;
    counts.retrievedTotal += candidates.length;
    counts.relevantRetrieved += candidates.filter((c) => expected.includes(c.id)).length;

    if (candidates[0] && expected.includes(candidates[0].id)) counts.top1Hits += 1;
    if (candidates.slice(0, 3).some((c) => expected.includes(c.id))) counts.top3Hits += 1;
  }

  return counts;
}

export function summarizeEntity(counts: EntityCounts): EntityMetrics {
  return {
    top1Rate: ratio(counts.top1Hits, counts.annotatedTurns),
    top3Rate: ratio(counts.top3Hits, counts.annotatedTurns),
    recall: ratio(counts.relevantRetrieved, counts.expectedTotal),
    precision: ratio(counts.relevantRetrieved, counts.retrievedTotal),
  };
}

export function computeEntityMetrics(session: VoiceEvalSession): EntityMetrics {
  return summarizeEntity(computeEntityCounts(session));
}

// ---------------------------------------------------------------------------
// 信頼性（transport / 失敗表現）
// ---------------------------------------------------------------------------

export type ReliabilityCounts = {
  sessions: number;
  abortedSessions: number;
  errorEvents: number;
  reconnects: number;
  disconnects: number;
  jitterSamples: number[];
};

export type ReliabilityMetrics = {
  /** 途中終了したセッションの割合。失敗した provider が「イベントが少ないだけ」に見えるのを防ぐ。 */
  abortedSessionRate: number | null;
  errorEventsPerSession: number | null;
  reconnectsPerSession: number | null;
  jitterMs: LatencySummary;
};

export function computeReliabilityCounts(session: VoiceEvalSession): ReliabilityCounts {
  const counts: ReliabilityCounts = {
    sessions: 1,
    abortedSessions: 0,
    errorEvents: 0,
    reconnects: 0,
    disconnects: 0,
    jitterSamples: [],
  };

  for (const event of session.events) {
    if (event.type === 'session.aborted') counts.abortedSessions = 1;
    if (event.type === 'error') counts.errorEvents += 1;
    if (event.type === 'transport.reconnecting') counts.reconnects += 1;
    if (event.type === 'transport.disconnected') counts.disconnects += 1;
    if (event.type === 'transport.stats') counts.jitterSamples.push(event.jitterMs);
  }

  return counts;
}

export function summarizeReliability(counts: ReliabilityCounts): ReliabilityMetrics {
  return {
    abortedSessionRate: ratio(counts.abortedSessions, counts.sessions),
    errorEventsPerSession: ratio(counts.errorEvents, counts.sessions),
    reconnectsPerSession: ratio(counts.reconnects, counts.sessions),
    jitterMs: latencySummary(counts.jitterSamples),
  };
}

export function computeReliabilityMetrics(session: VoiceEvalSession): ReliabilityMetrics {
  return summarizeReliability(computeReliabilityCounts(session));
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

export type VoiceEvalSessionMetrics = {
  sessionId: string;
  locale: string;
  providers: VoiceEvalSession['providers'];
  latency: LatencyMetrics;
  stt: SttMetrics;
  turn: TurnMetrics;
  bargeIn: BargeInMetrics;
  entity: EntityMetrics;
  reliability: ReliabilityMetrics;
  /** スイート集計のために保持する生サンプル / 分子分母。 */
  raw: {
    latency: LatencySamples;
    stt: SttCounts;
    turn: TurnCounts;
    bargeIn: BargeInCounts;
    entity: EntityCounts;
    reliability: ReliabilityCounts;
  };
};

export function computeSessionMetrics(session: VoiceEvalSession): VoiceEvalSessionMetrics {
  const latencySamples = computeLatencySamples(session);
  const sttCounts = computeSttCounts(session);
  const turnCounts = computeTurnCounts(session);
  const bargeInCounts = computeBargeInCounts(session);
  const entityCounts = computeEntityCounts(session);
  const reliabilityCounts = computeReliabilityCounts(session);

  return {
    sessionId: session.sessionId,
    locale: session.locale,
    providers: session.providers,
    latency: summarizeLatency(latencySamples),
    stt: summarizeStt(sttCounts),
    turn: summarizeTurn(turnCounts),
    bargeIn: summarizeBargeIn(bargeInCounts),
    entity: summarizeEntity(entityCounts),
    reliability: summarizeReliability(reliabilityCounts),
    raw: {
      latency: latencySamples,
      stt: sttCounts,
      turn: turnCounts,
      bargeIn: bargeInCounts,
      entity: entityCounts,
      reliability: reliabilityCounts,
    },
  };
}

export type VoiceEvalSuiteMetrics = {
  sessionCount: number;
  latency: LatencyMetrics;
  stt: SttMetrics;
  turn: TurnMetrics;
  bargeIn: BargeInMetrics;
  entity: EntityMetrics;
  reliability: ReliabilityMetrics;
};

function sumCounts<T extends Record<string, number | number[]>>(items: readonly T[], empty: T): T {
  return items.reduce<T>((acc, item) => {
    const merged = { ...acc } as Record<string, number | number[]>;
    for (const [key, value] of Object.entries(item)) {
      const current = merged[key];
      merged[key] = Array.isArray(value)
        ? [...((current as number[]) ?? []), ...value]
        : ((current as number) ?? 0) + value;
    }
    return merged as T;
  }, empty);
}

/**
 * セッション指標を横断集計する。**割合の平均ではなく分子分母の合算**から取り直すため、
 * ターン数の異なるセッションが混ざっても重み付けが狂わない。
 */
export function computeSuiteMetrics(sessions: readonly VoiceEvalSessionMetrics[]): VoiceEvalSuiteMetrics {
  const latency = emptySamples();
  for (const session of sessions) {
    for (const key of LATENCY_KEYS) latency[key].push(...session.raw.latency[key]);
  }

  const stt = sumCounts(
    sessions.map((s) => s.raw.stt),
    {
      cerSamples: [],
      editDistanceTotal: 0,
      referenceCharTotal: 0,
      personNameMatches: 0,
      personNameTotal: 0,
      departmentNameMatches: 0,
      departmentNameTotal: 0,
    },
  );
  const turn = sumCounts(
    sessions.map((s) => s.raw.turn),
    {
      falseCommits: 0,
      shouldNotCommitTotal: 0,
      missedEnds: 0,
      shouldCommitTotal: 0,
      fillerFalseResponses: 0,
      fillerTotal: 0,
    },
  );
  const bargeIn = sumCounts(
    sessions.map((s) => s.raw.bargeIn),
    {
      interruptionStopped: 0,
      interruptionTotal: 0,
      backchannelStopped: 0,
      backchannelTotal: 0,
      echoStopped: 0,
      echoTotal: 0,
      nonInterruptionStopped: 0,
      nonInterruptionTotal: 0,
      detectedStimuli: 0,
      stimuliTotal: 0,
      spuriousObservations: 0,
      bargeInStops: 0,
      unattributedStops: 0,
    },
  );
  const entity = sumCounts(
    sessions.map((s) => s.raw.entity),
    { top1Hits: 0, top3Hits: 0, annotatedTurns: 0, relevantRetrieved: 0, expectedTotal: 0, retrievedTotal: 0 },
  );
  const reliability = sumCounts(
    sessions.map((s) => s.raw.reliability),
    { sessions: 0, abortedSessions: 0, errorEvents: 0, reconnects: 0, disconnects: 0, jitterSamples: [] },
  );

  return {
    sessionCount: sessions.length,
    latency: summarizeLatency(latency),
    stt: summarizeStt(stt),
    turn: summarizeTurn(turn),
    bargeIn: summarizeBargeIn(bargeIn),
    entity: summarizeEntity(entity),
    reliability: summarizeReliability(reliability),
  };
}
