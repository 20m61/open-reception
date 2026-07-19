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
 * 注意: 本モジュールは正解ラベルを見て割り込みの停止可否を決める（実装ではなく**模擬**なので
 * 許される）。実 provider はこれをせず、音響・VAD から判断する。
 *
 * 実音声ファイルは扱わない。入力は合成発話テキストのみ（#365 のデータ方針: 実音声は
 * 明示的同意・匿名化・ライセンスが必須のため既定では持ち込まない）。
 */
import {
  VOICE_EVAL_SCHEMA_VERSION,
  type VoiceEvalEvent,
  type VoiceEvalSession,
} from '@/domain/voice/evaluation-events';
import type { VoiceEvalProvider, VoiceEvalScenario } from '@/domain/voice/evaluation-runner';

/** 近端発話（TTS 再生中の発話）の発生仕様。`groundTruth.nearEndOnsets` と同じ順序で並べること。 */
export type NearEndSpec = {
  turnIndex: number;
  /** その turn の playback_start からの経過ミリ秒。 */
  offsetFromPlaybackStartMs: number;
};

export type VoiceEvalDatasetEntry = {
  scenario: VoiceEvalScenario;
  /** 各ターンの発話長（audio.onset → speech.end）。 */
  speechDurationMs: number;
  nearEnd: NearEndSpec[];
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
   * - `slow`  … 確定すべき最初のターンを取りこぼす（終了見逃し）。
   *              全ターンを落とすと応答音声が一切出ず、近端発話の注釈と噛み合わなくなるため、
   *              1 ターンだけ落として他の計測は生かす。
   */
  turnPolicy: 'ideal' | 'naive' | 'slow';
  /** 書き起こしの誤り注入。正解 → 誤認識の置換表（同音異字の再現に使う）。 */
  misrecognitions?: Record<string, string>;
  /** Entity 解決で正解を何位に置くか。`miss` は候補に含めない。 */
  entityRank: 1 | 2 | 3 | 'miss';
  /** viseme を音声タイムスタンプからどれだけずらして適用するか。 */
  visemeSkewMs?: number;
};

function transcribe(reference: string, misrecognitions: Record<string, string> | undefined): string {
  if (!misrecognitions) return reference;
  return Object.entries(misrecognitions).reduce(
    (text, [correct, wrong]) => text.replaceAll(correct, wrong),
    reference,
  );
}

function entityCandidates(expectedId: string, rank: SyntheticProviderConfig['entityRank']) {
  const distractors = ['distractor-a', 'distractor-b', 'distractor-c'];
  const ids = rank === 'miss' ? distractors : [...distractors];
  if (rank !== 'miss') ids.splice(rank - 1, 0, expectedId);
  return ids.slice(0, 4).map((id, index) => ({ id, kind: 'staff' as const, score: 1 - index * 0.1 }));
}

/** ターン間の余白。ターンが重ならないよう十分に取る。 */
const TURN_GAP_MS = 500;

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
      const labels = scenario.groundTruth.nearEndOnsets;
      let nearEndCursor = 0;
      let clock = 0;
      let missedEndBudget = config.turnPolicy === 'slow' ? 1 : 0;

      for (const turn of scenario.groundTruth.turns) {
        const turnIndex = turn.turnIndex;
        const onsetAt = clock;

        events.push({ t: onsetAt, turnIndex, type: 'audio.onset' });
        events.push({
          t: onsetAt + config.firstPartialMs,
          turnIndex,
          type: 'stt.partial',
          text: turn.referenceTranscript.slice(0, 2),
          stable: false,
        });
        events.push({
          t: onsetAt + config.stablePartialMs,
          turnIndex,
          type: 'stt.partial',
          text: turn.referenceTranscript.slice(0, 4),
          stable: true,
        });

        const speechEndAt = onsetAt + entry.speechDurationMs;
        events.push({ t: speechEndAt, turnIndex, type: 'speech.end' });
        events.push({
          t: speechEndAt + 20,
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
          clock = speechEndAt + TURN_GAP_MS;
          continue;
        }

        const committedAt = speechEndAt + config.commitMs;
        events.push({ t: committedAt, turnIndex, type: 'turn.committed', text: turn.referenceTranscript, trigger: 'silence' });

        const expectedId = turn.expectedEntityIds?.[0];
        if (expectedId) {
          events.push({
            t: committedAt + 5,
            turnIndex,
            type: 'entity.resolved',
            query: turn.referenceTranscript,
            candidates: entityCandidates(expectedId, config.entityRank),
          });
        }

        events.push({
          t: committedAt + config.synthesisRequestMs,
          turnIndex,
          type: 'tts.request',
          text: `${turn.referenceTranscript} を承りました`,
        });
        events.push({ t: committedAt + config.firstByteMs, turnIndex, type: 'tts.first_byte' });

        const playbackStartAt = committedAt + config.firstAudioMs;
        events.push({ t: playbackStartAt, turnIndex, type: 'tts.playback_start' });

        if (config.visemeSkewMs !== undefined) {
          const audioTimestampMs = 100;
          events.push({
            t: playbackStartAt + audioTimestampMs + config.visemeSkewMs,
            turnIndex,
            type: 'vrm.viseme_applied',
            audioTimestampMs,
          });
        }

        // この turn で起きる近端発話（再生中の発話）。
        const turnNearEnd = entry.nearEnd.filter((n) => n.turnIndex === turnIndex);
        let stoppedAt: number | null = null;
        for (const spec of turnNearEnd) {
          const onset = playbackStartAt + spec.offsetFromPlaybackStartMs;
          events.push({ t: onset, turnIndex, type: 'audio.onset' });

          const label = labels[nearEndCursor]?.label;
          nearEndCursor += 1;
          const shouldStop =
            config.bargeInPolicy === 'naive'
              ? true
              : config.bargeInPolicy === 'deaf'
                ? false
                : label === 'interruption';
          if (shouldStop && stoppedAt === null) stoppedAt = onset + config.bargeInStopMs;
        }

        if (stoppedAt !== null) {
          events.push({ t: stoppedAt, turnIndex, type: 'tts.playback_stopped', reason: 'barge_in' });
          clock = stoppedAt + TURN_GAP_MS;
        } else {
          const endAt = playbackStartAt + config.playbackDurationMs;
          events.push({ t: endAt, turnIndex, type: 'tts.playback_stopped', reason: 'completed' });
          clock = endAt + TURN_GAP_MS;
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
