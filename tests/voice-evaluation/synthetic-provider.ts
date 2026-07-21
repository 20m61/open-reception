/**
 * 合成 provider (issue #365)。
 *
 * 実 Transcribe / Polly を呼ばずに、共通イベント列を**決定論的に生成**する。役割は 2 つ:
 *
 * 1. #370 (STT) / #371 (TTS) / #372 (Turn) の実装が入るまでの先行 mock。
 *    実 provider は同じ `VoiceEvalProvider` に差し替わる。
 * 2. ハーネス自身の検証。遅延・ターン方針・割り込み方針をノブとして持つので、
 *    「性能を落としたら SLO 判定が確かに赤くなるか」をオフラインで確認できる。
 *
 * 近端発話の扱い: 実機の評価では、相づちや環境音は**試験装置が決まった時刻に再生する刺激**であり、
 * provider の都合で時刻が動くものではない。ここでも同じモデルにし、刺激は絶対時刻
 * (`groundTruth.nearEndStimuli[].atMs`) で与える。provider は「その時刻が自分の再生区間の中に
 * 入っていれば onset として観測する」だけ。応答が遅れて刺激が再生区間から外れれば、それは
 * **検出漏れとして計測される**（以前のようにスキーマ違反にはならない）。
 *
 * 注意: 本モジュールは正解ラベルを見て割り込みの停止可否を決める（実装ではなく**模擬**なので
 * 許される）。実 provider はこれをせず、音響・VAD から判断する。
 *
 * 実音声ファイルは扱わない。入力は合成発話テキストのみ（#365 のデータ方針）。
 */
import {
  VOICE_EVAL_SCHEMA_VERSION,
  type VoiceEvalEvent,
  type VoiceEvalNearEndLabel,
  type VoiceEvalNearEndStimulus,
  type VoiceEvalSession,
  type VoiceEvalTurnGroundTruth,
} from '@/domain/voice/evaluation-events';
import type { VoiceEvalProvider } from '@/domain/voice/evaluation-runner';
import type { VoiceEvalScenario } from '@/domain/voice/evaluation-runner';

/** 近端発話の刺激仕様。基準タイムラインからの相対位置で書き、絶対時刻へ解決する。 */
export type NearEndSpec = {
  id: string;
  turnIndex: number;
  /** そのターンの playback_start からの経過ミリ秒。 */
  offsetFromPlaybackStartMs: number;
  label: VoiceEvalNearEndLabel;
};

export type VoiceEvalDatasetSpec = {
  id: string;
  description: string;
  tags: string[];
  /** 各ターンの発話長（audio.onset → speech.end）。 */
  speechDurationMs: number;
  turns: VoiceEvalTurnGroundTruth[];
  nearEnd: NearEndSpec[];
};

export type VoiceEvalDatasetEntry = {
  scenario: VoiceEvalScenario;
  speechDurationMs: number;
};

export type SyntheticProviderConfig = {
  id: string;
  providers: VoiceEvalSession['providers'];
  /** audio.onset → 初回 partial。 */
  firstPartialMs: number;
  /** audio.onset → 確定 partial。 */
  stablePartialMs: number;
  /** speech.end → turn.committed。 */
  commitMs: number;
  /** turn.committed → tts.request → first_byte → playback_start の各段。 */
  synthesisRequestMs: number;
  firstByteMs: number;
  firstAudioMs: number;
  /** 応答音声の長さ。 */
  playbackDurationMs: number;
  /** 近端発話に反応して止めるまでの時間。 */
  bargeInStopMs: number;
  /**
   * 割り込み方針。
   * - `ideal`  … 真の割り込みだけ止める
   * - `naive`  … 近端発話なら何でも止める（相づち・エコーで誤停止する）
   * - `deaf`   … 一切止めない（割り込みを取りこぼす）
   */
  bargeInPolicy: 'ideal' | 'naive' | 'deaf';
  /**
   * ターン終了方針。
   * - `ideal` … `shouldCommit` のとおりに確定する
   * - `naive` … フィラーで終わる発話も確定してしまう（誤終了）
   * - `slow`  … **各シナリオの最初の**確定すべきターンを取りこぼす（終了見逃し）。
   *             全ターンを落とすと応答音声が一切出ず、他の指標が計測不能になるため 1 件に留める。
   */
  turnPolicy: 'ideal' | 'naive' | 'slow';
  /** 書き起こしの誤り注入。正解 → 誤認識の置換表（同音異字の再現に使う）。 */
  misrecognitions?: Record<string, string>;
  /** Entity 解決で正解を何位に置くか。`miss` は候補に含めない。 */
  entityRank: 1 | 2 | 3 | 'miss';
  /** viseme を音声タイムスタンプからどれだけずらして適用するか。 */
  visemeSkewMs?: number;
  /** 指定するとそのターンで `session.aborted` を出して以降を打ち切る（失敗表現の検証用）。 */
  abortAtTurn?: number;
};

/** ターン間の余白。ターンが重ならないよう十分に取る。 */
const TURN_GAP_MS = 500;

/** 刺激と観測 onset を対応付ける許容幅。応答時刻の小さなぶれで検出漏れ扱いにしないための余裕。 */
const STIMULUS_TOLERANCE_MS = 400;

/** 基準となる「よくできた」provider 設定。ここから 1 ノブずつ崩して回帰検知を確認する。 */
export const BASELINE_SYNTHETIC_CONFIG: Omit<SyntheticProviderConfig, 'id' | 'providers'> = {
  firstPartialMs: 140,
  stablePartialMs: 250,
  commitMs: 120,
  synthesisRequestMs: 10,
  firstByteMs: 90,
  firstAudioMs: 220,
  playbackDurationMs: 2000,
  bargeInStopMs: 120,
  bargeInPolicy: 'ideal',
  turnPolicy: 'ideal',
  entityRank: 1,
  visemeSkewMs: 15,
};

type TurnTiming = { onsetAt: number; speechEndAt: number; committedAt: number; playbackStartAt: number };

function turnTiming(
  config: Pick<SyntheticProviderConfig, 'commitMs' | 'firstAudioMs'>,
  onsetAt: number,
  speechDurationMs: number,
): TurnTiming {
  const speechEndAt = onsetAt + speechDurationMs;
  const committedAt = speechEndAt + config.commitMs;
  return { onsetAt, speechEndAt, committedAt, playbackStartAt: committedAt + config.firstAudioMs };
}

/**
 * 基準タイムラインを走らせて、各刺激の絶対時刻を求める。
 *
 * データセット側は「そのターンの応答が鳴り始めて N ミリ秒後に相づちを入れる」と書きたいが、
 * 正解は provider の都合で動いてはいけない。そこで**基準 provider のタイムライン 1 回だけ**で
 * 絶対時刻へ解決し、以後はその固定値を正解として使う。
 */
function resolveNearEndStimuli(spec: VoiceEvalDatasetSpec): VoiceEvalNearEndStimulus[] {
  const config = BASELINE_SYNTHETIC_CONFIG;
  const resolved: VoiceEvalNearEndStimulus[] = [];
  let clock = 0;

  for (const turn of spec.turns) {
    const timing = turnTiming(config, clock, spec.speechDurationMs);
    if (!turn.shouldCommit) {
      clock = timing.speechEndAt + TURN_GAP_MS;
      continue;
    }

    const specs = spec.nearEnd
      .filter((n) => n.turnIndex === turn.turnIndex)
      .sort((a, b) => a.offsetFromPlaybackStartMs - b.offsetFromPlaybackStartMs);

    let stopAt: number | null = null;
    for (const nearEnd of specs) {
      const atMs = timing.playbackStartAt + nearEnd.offsetFromPlaybackStartMs;
      resolved.push({ id: nearEnd.id, atMs, toleranceMs: STIMULUS_TOLERANCE_MS, label: nearEnd.label });
      // 基準 provider は真の割り込みだけで止まる。
      if (nearEnd.label === 'interruption' && stopAt === null) stopAt = atMs + config.bargeInStopMs;
    }

    clock = (stopAt ?? timing.playbackStartAt + config.playbackDurationMs) + TURN_GAP_MS;
  }

  return resolved;
}

/** データセット仕様からシナリオを組み立てる（正解の絶対時刻を解決する）。 */
export function buildDatasetEntry(spec: VoiceEvalDatasetSpec): VoiceEvalDatasetEntry {
  return {
    speechDurationMs: spec.speechDurationMs,
    scenario: {
      id: spec.id,
      locale: 'ja-JP',
      description: spec.description,
      tags: spec.tags,
      input: {
        kind: 'synthetic',
        utterances: spec.turns.map((turn) => ({ turnIndex: turn.turnIndex, text: turn.referenceTranscript })),
      },
      groundTruth: { turns: spec.turns, nearEndStimuli: resolveNearEndStimuli(spec) },
    },
  };
}

function transcribe(reference: string, misrecognitions: Record<string, string> | undefined): string {
  if (!misrecognitions) return reference;
  return Object.entries(misrecognitions).reduce(
    (text, [correct, wrong]) => text.replaceAll(correct, wrong),
    reference,
  );
}

function entityCandidates(expectedId: string, rank: SyntheticProviderConfig['entityRank']) {
  const ids = ['distractor-a', 'distractor-b', 'distractor-c'];
  if (rank !== 'miss') ids.splice(rank - 1, 0, expectedId);
  return ids.slice(0, 4).map((id, index) => ({ id, kind: 'staff' as const, score: 1 - index * 0.1 }));
}

export function createSyntheticProvider(
  config: SyntheticProviderConfig,
  entries: readonly VoiceEvalDatasetEntry[],
): VoiceEvalProvider {
  const byScenarioId = new Map(entries.map((e) => [e.scenario.id, e]));

  return {
    id: config.id,
    run: async (scenario) => {
      const entry = byScenarioId.get(scenario.id);
      if (!entry) throw new Error(`synthetic provider '${config.id}': シナリオ '${scenario.id}' の定義が無い`);

      const events: VoiceEvalEvent[] = [];
      const stimuli = scenario.groundTruth.nearEndStimuli;
      let clock = 0;
      let missedEndBudget = config.turnPolicy === 'slow' ? 1 : 0;

      events.push({ t: 0, turnIndex: 0, type: 'transport.connected' });
      events.push({ t: 1, turnIndex: 0, type: 'transport.stream_open' });

      for (const turn of scenario.groundTruth.turns) {
        const turnIndex = turn.turnIndex;

        if (config.abortAtTurn === turnIndex) {
          events.push({ t: clock, turnIndex, type: 'session.aborted', stage: 'transport', code: 'stream_closed' });
          break;
        }

        const timing = turnTiming(config, clock, entry.speechDurationMs);

        events.push({ t: timing.onsetAt, turnIndex, type: 'audio.onset' });
        events.push({
          t: timing.onsetAt + config.firstPartialMs,
          turnIndex,
          type: 'stt.partial',
          text: turn.referenceTranscript.slice(0, 2),
          stable: false,
        });
        events.push({
          t: timing.onsetAt + config.stablePartialMs,
          turnIndex,
          type: 'stt.partial',
          text: turn.referenceTranscript.slice(0, 4),
          stable: true,
        });
        events.push({ t: timing.speechEndAt, turnIndex, type: 'speech.end' });
        events.push({
          t: timing.speechEndAt + 20,
          turnIndex,
          type: 'stt.final',
          text: transcribe(turn.referenceTranscript, config.misrecognitions),
        });

        let commits = config.turnPolicy === 'naive' ? true : turn.shouldCommit;
        if (config.turnPolicy === 'slow' && turn.shouldCommit && missedEndBudget > 0) {
          commits = false;
          missedEndBudget -= 1;
        }

        if (!commits) {
          clock = timing.speechEndAt + TURN_GAP_MS;
          continue;
        }

        events.push({
          t: timing.committedAt,
          turnIndex,
          type: 'turn.committed',
          text: turn.referenceTranscript,
          trigger: 'silence',
        });

        const expectedId = turn.expectedEntityIds?.[0];
        if (expectedId) {
          events.push({
            t: timing.committedAt + 5,
            turnIndex,
            type: 'entity.resolved',
            query: turn.referenceTranscript,
            candidates: entityCandidates(expectedId, config.entityRank),
          });
        }

        events.push({
          t: timing.committedAt + config.synthesisRequestMs,
          turnIndex,
          type: 'tts.request',
          text: `${turn.referenceTranscript} を承りました`,
        });
        events.push({ t: timing.committedAt + config.firstByteMs, turnIndex, type: 'tts.first_byte' });
        events.push({ t: timing.playbackStartAt, turnIndex, type: 'tts.playback_start' });

        if (config.visemeSkewMs !== undefined) {
          const audioTimestampMs = 100;
          events.push({
            t: timing.playbackStartAt + audioTimestampMs + config.visemeSkewMs,
            turnIndex,
            type: 'vrm.viseme_applied',
            audioTimestampMs,
          });
        }

        // 自然終了の時刻。刺激がこの区間の内側にあれば onset として観測できる。
        const naturalEndAt = timing.playbackStartAt + config.playbackDurationMs;
        const inWindow = stimuli
          .filter((s) => s.atMs > timing.playbackStartAt && s.atMs < naturalEndAt)
          .sort((a, b) => a.atMs - b.atMs);

        let stopAt: number | null = null;
        for (const stimulus of inWindow) {
          // 既に停止した後の刺激は再生中ではないので観測されない。
          if (stopAt !== null && stimulus.atMs >= stopAt) continue;

          events.push({ t: stimulus.atMs, turnIndex, type: 'audio.onset' });

          const shouldStop =
            config.bargeInPolicy === 'naive'
              ? true
              : config.bargeInPolicy === 'deaf'
                ? false
                : stimulus.label === 'interruption';
          if (shouldStop && stopAt === null) stopAt = stimulus.atMs + config.bargeInStopMs;
        }

        if (stopAt !== null) {
          events.push({ t: stopAt, turnIndex, type: 'tts.playback_stopped', reason: 'barge_in' });
          clock = stopAt + TURN_GAP_MS;
        } else {
          events.push({ t: naturalEndAt, turnIndex, type: 'tts.playback_stopped', reason: 'completed' });
          clock = naturalEndAt + TURN_GAP_MS;
        }
      }

      return {
        schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
        sessionId: `${config.id}/${scenario.id}`,
        locale: scenario.locale,
        providers: config.providers,
        events: events.sort((a, b) => a.t - b.t),
        groundTruth: scenario.groundTruth,
      };
    },
  };
}
