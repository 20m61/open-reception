/**
 * #365 適合の実証 (issue #372)。
 *
 * `docs/voice-evaluation-harness.md`「#369〜#372 の適合の示し方」に従い、この Turn 実装が
 * 実際に #365 の共通イベント形式へ正しく橋渡しできることを示す。
 *
 * 重要: `tests/voice-evaluation/synthetic-provider.ts` の mock とは違い、**正解ラベル
 * (`nearEndStimuli[].label`) を一切参照しない**。ここで使うのは:
 *  - `turn-detector.ts` の `decideTurnEnd`（テキストと無音時間から確定を判定）
 *  - `near-end-classifier.ts` の `classifyNearEnd`（テキスト・継続時間・エコー尤度から分類）
 *  - `barge-in-controller.ts` の `onNearEndOnset`/`onNearEndUpdate`（duck→分類→停止/再開）
 * だけであり、いずれも正解ラベルにアクセスできない純関数として実装されている
 * （`near-end-classifier.ts` の設計方針コメント参照）。
 *
 * タイムスタンプは全て上記の関数呼び出しの**戻り値**から導出する（決め打ちの定数ではない）。
 * `evaluation-demo.test.ts` はこの `buildDemoSession()` の出力に対して
 * `validateVoiceEvalSession` と `evaluateAgainstSlo(VOICE_EVAL_PROFILES.ci)` を実行する。
 */
import {
  onNearEndOnset,
  onNearEndUpdate,
  initialBargeInControllerState,
  type BargeInControllerState,
} from './barge-in-controller';
import { DEFAULT_FILLER_TAIL_PATTERNS, decideTurnEnd } from './turn-detector';
import type { TurnSlot } from './types';
import { audioOnsetEvent, bargeInPlaybackStoppedEvent, speechEndEvent, turnCommittedEvent } from './eval-bridge';
import type { NearEndClassification, NearEndSignal } from './near-end-classifier';
import {
  VOICE_EVAL_SCHEMA_VERSION,
  type VoiceEvalEvent,
  type VoiceEvalGroundTruth,
  type VoiceEvalNearEndLabel,
  type VoiceEvalNearEndStimulus,
  type VoiceEvalSession,
  type VoiceEvalTurnGroundTruth,
} from '@/domain/voice/evaluation-events';

/**
 * 分類結果 → 正解ラベル語彙への写像。`pending` のまま解決しなかった場合は呼び出し側の
 * `updates` 設計ミス（150〜250ms の継続確認を完了させていない）なので、あいまいに丸めず
 * 例外にする（#365「性能の失敗をスキーマ違反にしない」は provider の出力についての方針であり、
 * この demo のシナリオ構築コード自体のバグはここで検出してよい）。
 */
function toNearEndLabel(classification: NearEndClassification): VoiceEvalNearEndLabel {
  switch (classification) {
    case 'interruption':
      return 'interruption';
    case 'backchannel':
      return 'backchannel';
    case 'echo':
      return 'echo';
    case 'noise':
      return 'environment';
    case 'pending':
      throw new Error('near-end burst が pending のまま解決していない（updates の継続確認が不足している）');
  }
}

/** 1 ユーザーターンの入力仕様。silenceObservedMs は「実際に観測された無音時間」を表す。 */
type UserTurnSpec = {
  turnIndex: number;
  onsetAt: number;
  speechDurationMs: number;
  text: string;
  slot?: TurnSlot;
  /** 発話終了後に観測された無音時間。`decideTurnEnd` へそのまま渡す。 */
  silenceObservedMs: number;
  utteranceKind?: 'short_answer' | 'free_form';
};

type UserTurnResult = {
  events: VoiceEvalEvent[];
  groundTruth: VoiceEvalTurnGroundTruth;
  /** 確定した場合の確定時刻（bot 応答のタイミング計算に使う）。未確定なら null。 */
  committedAt: number | null;
};

/** ユーザーターン 1 件を、実際の `decideTurnEnd` 呼び出し結果に基づいて構築する。 */
function runUserTurn(spec: UserTurnSpec): UserTurnResult {
  const speechEndAt = spec.onsetAt + spec.speechDurationMs;
  const decision = decideTurnEnd({ text: spec.text, silenceMs: spec.silenceObservedMs, slot: spec.slot });

  const events: VoiceEvalEvent[] = [audioOnsetEvent(spec.onsetAt, spec.turnIndex), speechEndEvent(speechEndAt, spec.turnIndex)];

  let committedAt: number | null = null;
  if (decision.commit) {
    committedAt = speechEndAt + spec.silenceObservedMs;
    events.push(turnCommittedEvent(committedAt, spec.text, decision.trigger, spec.turnIndex));
  }

  return {
    events,
    committedAt,
    groundTruth: {
      turnIndex: spec.turnIndex,
      referenceTranscript: spec.text,
      shouldCommit: decision.commit,
      endsWithFiller: DEFAULT_FILLER_TAIL_PATTERNS.some((p) => spec.text.trim().endsWith(p)),
      ...(spec.utteranceKind ? { utteranceKind: spec.utteranceKind } : {}),
    },
  };
}

/** bot 応答の合成タイミング設定（すべての turn で共通の定数として使う）。 */
const SYNTHESIS_REQUEST_MS = 10;
const FIRST_AUDIO_MS = 220;
const PLAYBACK_DURATION_MS = 1500;

type BotResponseSpec = {
  turnIndex: number;
  committedAt: number;
  text: string;
  /**
   * playbackStart からの相対時刻で与える近端発話の観測列。1 件が 1 バースト（= 1 回の
   * `audio.onset`）に対応し、`updates` は同じバーストに対する複数回の分類呼び出し
   * （150〜250ms の継続確認を表す）。
   */
  nearEndBursts: {
    id: string;
    offsetFromPlaybackStartMs: number;
    updates: { sustainedMs: number; signal: Omit<NearEndSignal, 'sustainedMs'> }[];
  }[];
};

type BotResponseResult = {
  events: VoiceEvalEvent[];
  /** 実際に発生した停止（barge-in）を正解として記録するための情報。 */
  stimuli: VoiceEvalNearEndStimulus[];
};

/** bot 応答 1 件を実行する。近端発話バーストは `barge-in-controller.ts` の実関数で処理する。 */
function runBotResponse(spec: BotResponseSpec): BotResponseResult {
  const ttsRequestAt = spec.committedAt + SYNTHESIS_REQUEST_MS;
  const playbackStartAt = spec.committedAt + FIRST_AUDIO_MS;
  const naturalEndAt = playbackStartAt + PLAYBACK_DURATION_MS;

  const events: VoiceEvalEvent[] = [
    { type: 'tts.request', t: ttsRequestAt, turnIndex: spec.turnIndex, text: spec.text },
    { type: 'tts.playback_start', t: playbackStartAt, turnIndex: spec.turnIndex },
  ];
  const stimuli: VoiceEvalNearEndStimulus[] = [];

  let controllerState: BargeInControllerState = initialBargeInControllerState();
  let stoppedAt: number | null = null;
  let stoppedLabelSource: 'interruption' | null = null;

  for (const burst of spec.nearEndBursts) {
    if (stoppedAt !== null) break; // 既に停止済みなら以降のバーストは再生区間の外なので処理しない。

    const onsetAt = playbackStartAt + burst.offsetFromPlaybackStartMs;
    const onset = onNearEndOnset(controllerState, `${spec.turnIndex}`);
    controllerState = onset.state;
    events.push(audioOnsetEvent(onsetAt, spec.turnIndex));

    let classification: NearEndClassification = 'pending';
    for (const update of burst.updates) {
      const result = onNearEndUpdate(controllerState, { ...update.signal, sustainedMs: update.sustainedMs });
      controllerState = result.state;
      classification = result.classification;
      if (result.action.type === 'stop_and_discard') {
        stoppedAt = onsetAt + update.sustainedMs;
        stoppedLabelSource = 'interruption';
        break;
      }
      if (result.action.type === 'resume') break; // このバーストの判定は確定した（backchannel/noise/echo）。
    }

    stimuli.push({ id: burst.id, atMs: onsetAt, toleranceMs: 300, label: toNearEndLabel(classification) });
  }

  if (stoppedAt !== null && stoppedLabelSource === 'interruption') {
    events.push(bargeInPlaybackStoppedEvent(stoppedAt, spec.turnIndex));
  } else {
    events.push({ type: 'tts.playback_stopped', t: naturalEndAt, turnIndex: spec.turnIndex, reason: 'completed' });
  }

  return { events, stimuli };
}

export type VoiceTurnDemoSession = {
  session: VoiceEvalSession;
};

/**
 * #372 の全コンポーネントを実際に駆動してセッションを構築する。
 *
 * 5 ターン構成:
 * 0. 短答「はい」→ 短い無音で確定（issue AC「短答では不必要な待機をせず応答開始」）。
 * 1. フィラー「えーと、あの」→ 必要無音時間に届かず確定しない（issue AC「早すぎる応答をしない」）。
 * 2. 継続発話「配送でお伺いしました」→ 応答中に相づち（誤停止しない）→ 明示的な訂正フレーズで
 *    速やかに停止（issue AC「明示的な訂正では速やかに停止」「短い相づちだけで頻繁に停止しない」）。
 * 3. 「そうです」→ 応答中に自己音声エコー相当の近端発話（誤って割り込みと判定しない）。
 * 4. 「採用の面接で参りました」→ 応答中に環境音相当の近端発話（誤って割り込みと判定しない）。
 */
export function buildVoiceTurnDemoSession(): VoiceTurnDemoSession {
  const events: VoiceEvalEvent[] = [];
  const turns: VoiceEvalTurnGroundTruth[] = [];
  const nearEndStimuli: VoiceEvalNearEndStimulus[] = [];

  // --- turn 0: 短答 ---
  const turn0 = runUserTurn({
    turnIndex: 0,
    onsetAt: 0,
    speechDurationMs: 400,
    text: 'はい',
    slot: 'name',
    silenceObservedMs: 250, // = requiredSilenceMs('はい') とちょうど同じ（短答の閾値どおり）。
    utteranceKind: 'short_answer',
  });
  events.push(...turn0.events);
  turns.push(turn0.groundTruth);
  if (turn0.committedAt !== null) {
    const bot0 = runBotResponse({ turnIndex: 0, committedAt: turn0.committedAt, text: '承知いたしました', nearEndBursts: [] });
    events.push(...bot0.events);
  }

  // --- turn 1: フィラーで終わる発話（確定させない） ---
  const turn1 = runUserTurn({
    turnIndex: 1,
    onsetAt: 2600,
    speechDurationMs: 500,
    text: 'えーと、あの',
    // 必要無音時間（500+900=1400ms）よりわずかに短い無音しか観測されていない → 確定しないはず。
    silenceObservedMs: 1399,
  });
  events.push(...turn1.events);
  turns.push(turn1.groundTruth);

  // --- turn 2: 継続発話。応答中に相づち→明示的訂正で割り込み ---
  const turn2 = runUserTurn({
    turnIndex: 2,
    onsetAt: 4600,
    speechDurationMs: 900,
    text: '配送でお伺いしました',
    slot: 'free_form',
    silenceObservedMs: 800, // = requiredSilenceMs(..., 'free_form')。
    utteranceKind: 'free_form',
  });
  events.push(...turn2.events);
  turns.push(turn2.groundTruth);
  if (turn2.committedAt !== null) {
    const bot2 = runBotResponse({
      turnIndex: 2,
      committedAt: turn2.committedAt,
      text: '配送の件、承知いたしました',
      nearEndBursts: [
        {
          id: 'turn2-backchannel',
          offsetFromPlaybackStartMs: 300,
          updates: [
            { sustainedMs: 90, signal: { text: 'は' } }, // まだ 150ms 未満 → pending。
            { sustainedMs: 200, signal: { text: 'はい' } }, // 150〜250ms の継続確認 → backchannel。
          ],
        },
        {
          id: 'turn2-interruption',
          offsetFromPlaybackStartMs: 980, // turn2-backchannel の許容窓（300ms）と重ならない間隔を確保。
          updates: [{ sustainedMs: 90, signal: { text: '戻って' } }], // 強制停止フレーズ → 即座に interruption。
        },
      ],
    });
    events.push(...bot2.events);
    nearEndStimuli.push(...bot2.stimuli);
  }

  // --- turn 3: 応答中に自己音声エコー ---
  const turn3 = runUserTurn({
    turnIndex: 3,
    onsetAt: 9000,
    speechDurationMs: 400,
    text: 'そうです',
    silenceObservedMs: 250,
    utteranceKind: 'short_answer',
  });
  events.push(...turn3.events);
  turns.push(turn3.groundTruth);
  if (turn3.committedAt !== null) {
    const bot3 = runBotResponse({
      turnIndex: 3,
      committedAt: turn3.committedAt,
      text: '承知いたしました',
      nearEndBursts: [
        {
          id: 'turn3-echo',
          offsetFromPlaybackStartMs: 200,
          updates: [{ sustainedMs: 90, signal: { text: 'そうです', echoLikelihood: 0.9 } }],
        },
      ],
    });
    events.push(...bot3.events);
    nearEndStimuli.push(...bot3.stimuli);
  }

  // --- turn 4: 応答中に環境音 ---
  const turn4 = runUserTurn({
    turnIndex: 4,
    onsetAt: 12000,
    speechDurationMs: 900,
    text: '採用の面接で参りました',
    slot: 'free_form',
    silenceObservedMs: 800,
    utteranceKind: 'free_form',
  });
  events.push(...turn4.events);
  turns.push(turn4.groundTruth);
  if (turn4.committedAt !== null) {
    const bot4 = runBotResponse({
      turnIndex: 4,
      committedAt: turn4.committedAt,
      text: '受付が承ります',
      nearEndBursts: [
        {
          id: 'turn4-noise',
          offsetFromPlaybackStartMs: 300,
          updates: [
            { sustainedMs: 90, signal: { text: '' } }, // pending。
            { sustainedMs: 400, signal: { text: '' } }, // 継続はしたが語彙化できない → noise。
          ],
        },
      ],
    });
    events.push(...bot4.events);
    nearEndStimuli.push(...bot4.stimuli);
  }

  const groundTruth: VoiceEvalGroundTruth = { turns, nearEndStimuli };

  return {
    session: {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'voice-turn-domain-demo',
      locale: 'ja-JP',
      providers: { stt: 'demo-stt', tts: 'demo-tts', turn: 'voice-turn-domain' },
      events: [...events].sort((a, b) => a.t - b.t),
      groundTruth,
    },
  };
}
