/**
 * 音声評価ハーネスの共通イベントスキーマ (issue #365)。
 *
 * 位置づけ: 本モジュールは #369 (Transport) / #370 (STT) / #371 (TTS) / #372 (Turn) が
 * **共通で書き出す計測イベントの契約**である。各実装はこの型でイベント列を出し、
 * `validateVoiceEvalSession` を自分のテストで通すことで適合を担保する。ここを先に固める
 * ことで、後続 4 issue が別々の計測形式を作って手戻りするのを防ぐ。
 *
 * 設計方針:
 * - イベントは「システムが観測した事実」だけを持つ。正解ラベルは `groundTruth` 側に分離する。
 * - 正解は **刺激（こちらが与えた入力）側**に紐づける。観測の通番に紐づけると、観測の取りこぼしで
 *   以降のラベルが全てずれる（`VoiceEvalNearEndStimulus` の説明を参照）。
 * - 時刻 `t` は **セッション開始からの相対ミリ秒・単一時計源**。壁時計や複数クロックを混ぜない
 *   （混ぜると遅延が負になり、無言で 0 に丸められた指標が緑になる）。
 * - 近端音声（TTS 再生中の発話）は専用イベントを作らず、再生区間中に落ちた `audio.onset` として
 *   導出する。実装側が「割り込みらしさ」を判断する前の生の観測だけを出せばよくなる。
 * - **生音声・音声 URI をイベントに載せない**。#365 は実音声のリポジトリ投入を明示的同意・
 *   匿名化・ライセンス必須としており、既定は合成音声と固定 fixture。バリデータが構造的に弾く。
 *
 * @see docs/voice-evaluation-harness.md
 */

/**
 * スキーマ版数。
 *
 * v2: 正解ラベルを観測通番 (`nearEndOnsets[].onsetIndex`) から刺激 (`nearEndStimuli[]`) へ移行。
 *     transport / error / session.aborted イベントを追加。
 *
 * バリデータはこの版数と**完全一致**するセッションだけを受け付ける。古い版数を「たぶん読める」と
 * 通すと、意味の変わったフィールドを黙って誤解釈するため（v1 の `onsetIndex` を v2 として読むと
 * ラベルが全てずれる）。移行はデータ側を明示的に書き換えて行う。
 */
export const VOICE_EVAL_SCHEMA_VERSION = 2;

/** ターンが確定した理由。誤終了の原因分析に使う。 */
export type VoiceEvalTurnTrigger = 'silence' | 'rule' | 'vad' | 'manual';

/** 再生が止まった理由。`barge_in` は「システムが割り込みと判断した」ことを意味する（正解ではない）。 */
export type VoiceEvalPlaybackStopReason = 'completed' | 'barge_in' | 'cancelled' | 'error';

/** 計測の段。`error` / `session.aborted` がどの層で起きたかを示す。 */
export type VoiceEvalStage = 'transport' | 'stt' | 'tts' | 'turn' | 'entity' | 'vrm';

/** Entity 解決の候補。`score` の降順で並ぶこと（Top1/Top3 判定が順序に依存するため）。 */
export type VoiceEvalEntityCandidate = {
  id: string;
  kind: 'staff' | 'department' | 'purpose' | 'other';
  score: number;
};

type VoiceEvalEventBase = {
  /** セッション開始からの相対ミリ秒（単一時計源・単調増加）。 */
  t: number;
  /** 何ターン目の観測か（0 始まり）。 */
  turnIndex: number;
};

/**
 * 共通イベント。issue #365 の「共通イベントと測定起点」を導出できる最小集合に、
 * transport (#369) と失敗表現を加えたもの。
 *
 * ```text
 * audio.onset          → stt.partial(first)      サーバ初回 partial までの遅延
 * audio.onset          → stt.partial(stable)     UI 確定 partial までの遅延
 * speech.end           → turn.committed          ターン確定までの遅延
 * turn.committed       → tts.playback_start      応答音声が鳴るまでの遅延
 * audio.onset(再生中)  → tts.playback_stopped    割り込み応答遅延
 * tts.playback_start   → vrm.viseme_applied      音声と口形の同期誤差
 * ```
 */
export type VoiceEvalEvent = VoiceEvalEventBase &
  (
    | { type: 'audio.onset' }
    | { type: 'speech.end' }
    | { type: 'stt.partial'; text: string; stable: boolean }
    | { type: 'stt.final'; text: string }
    | { type: 'turn.committed'; text: string; trigger: VoiceEvalTurnTrigger }
    | { type: 'entity.resolved'; query: string; candidates: VoiceEvalEntityCandidate[] }
    | { type: 'tts.request'; text: string }
    | { type: 'tts.first_byte' }
    | { type: 'tts.playback_start' }
    | { type: 'tts.playback_stopped'; reason: VoiceEvalPlaybackStopReason }
    | { type: 'vrm.viseme_applied'; audioTimestampMs: number }
    // --- transport (#369) ---
    | { type: 'transport.connected' }
    | { type: 'transport.reconnecting'; attempt: number }
    | { type: 'transport.disconnected'; reason: 'client' | 'server' | 'network' | 'timeout' }
    | { type: 'transport.stream_open' }
    /** 定期的な回線品質サンプル。遅延の原因が回線か処理かを切り分けるために使う。 */
    | { type: 'transport.stats'; droppedPackets: number; jitterMs: number }
    // --- 失敗の表現 ---
    /**
     * 回復可能な失敗。`code` は列挙可能な短い識別子に限る（例外メッセージをそのまま入れない
     * —— PII や内部パスが混入するため）。
     */
    | { type: 'error'; stage: VoiceEvalStage; code: string }
    /** セッションが途中で終わった。これを出さずに黙って短いイベント列を返してはいけない。 */
    | { type: 'session.aborted'; stage: VoiceEvalStage; code: string }
  );

export type VoiceEvalEventType = VoiceEvalEvent['type'];

const EVENT_TYPES: readonly VoiceEvalEventType[] = [
  'audio.onset',
  'speech.end',
  'stt.partial',
  'stt.final',
  'turn.committed',
  'entity.resolved',
  'tts.request',
  'tts.first_byte',
  'tts.playback_start',
  'tts.playback_stopped',
  'vrm.viseme_applied',
  'transport.connected',
  'transport.reconnecting',
  'transport.disconnected',
  'transport.stream_open',
  'transport.stats',
  'error',
  'session.aborted',
];

/**
 * 生音声を持ち込む経路になりうるフィールド名。#365 のデータ方針（実音声は明示的同意・匿名化・
 * ライセンス必須）を構造的に守るため、イベントに現れたら無効とする。
 */
const FORBIDDEN_EVENT_FIELDS = ['audioUri', 'audioUrl', 'audioBase64', 'rawAudio', 'waveform'] as const;

/** 発話の種類。応答遅延 SLO が短答と自由発話で違うため、正解側で区別する。 */
export type VoiceEvalUtteranceKind = 'short_answer' | 'free_form';

/** 近端発話（TTS 再生中の発話）の正解ラベル。 */
export type VoiceEvalNearEndLabel =
  | 'interruption' // 真の割り込み。止めるべき。
  | 'backchannel' // 相づち。止めてはいけない。
  | 'echo' // 自己音声エコー。止めてはいけない。
  | 'environment'; // 環境音・雑談。止めてはいけない。

export type VoiceEvalTurnGroundTruth = {
  turnIndex: number;
  /** 正解の書き起こし。CER の分母。 */
  referenceTranscript: string;
  /** このターンで確定すべきか。false は「フィラー等で切ってはいけない」ことを意味する。 */
  shouldCommit: boolean;
  /** フィラー・接続助詞で終わる発話か。フィラー起因の誤応答率の分母。 */
  endsWithFiller: boolean;
  utteranceKind?: VoiceEvalUtteranceKind;
  /** 正解の人名（`stt.final` に現れるべき表記。CER とは別指標）。 */
  expectedPersonNames?: string[];
  /** 正解の部門名（同上）。 */
  expectedDepartmentNames?: string[];
  /** Entity Resolver が返すべき ID 群。Top1/Top3・Recall/Precision の正解。 */
  expectedEntityIds?: string[];
};

/**
 * 近端発話の**刺激**（こちらが与えた入力）。
 *
 * 以前は「再生中に落ちた `audio.onset` の通番」で正解を指していたが、それは
 * **#372 が測ろうとしている失敗モードそのものに対して不安定**だった:
 * VAD が onset を 1 つ取りこぼすと以降のラベルが全てずれ（相づちが割り込みとして採点される）、
 * ターンが脱落すると注釈ごと無効化され、「実装が壊れた」が「計測が壊れた（スキーマ違反）」として
 * 現れてしまう。評価ハーネスが絶対に区別しなければならない 2 つを混同する設計だった。
 *
 * そこで正解は刺激側に固定し、観測 onset を `atMs ± toleranceMs` の窓でマッチングする。
 * 未マッチの刺激 = 検出漏れ、未マッチの観測 = 誤検出として、**どちらも指標として計測可能**にする
 * （以前はどちらも fatal だった）。
 */
export type VoiceEvalNearEndStimulus = {
  /** 安定した識別子。観測の増減で意味が動かないよう、通番ではなく名前で指す。 */
  id: string;
  /** 刺激を与えた時刻（セッション開始からの相対ミリ秒）。 */
  atMs: number;
  /** 観測 onset をこの刺激へ帰属させる許容幅（片側ミリ秒）。 */
  toleranceMs: number;
  label: VoiceEvalNearEndLabel;
};

export type VoiceEvalGroundTruth = {
  turns: VoiceEvalTurnGroundTruth[];
  nearEndStimuli: VoiceEvalNearEndStimulus[];
};

export type VoiceEvalSession = {
  schemaVersion: number;
  sessionId: string;
  locale: string;
  /** どの実装が出したイベントか。provider 比較の軸。 */
  providers: { stt: string; tts: string; turn: string; transport?: string };
  events: VoiceEvalEvent[];
  groundTruth: VoiceEvalGroundTruth;
};

export type VoiceEvalValidation = { valid: boolean; errors: string[] };

/** 時刻順に並べ替える（入力は変更しない）。同時刻は元の順序を保つ。 */
export function sortVoiceEvalEvents(events: readonly VoiceEvalEvent[]): VoiceEvalEvent[] {
  return [...events].sort((a, b) => a.t - b.t);
}

/**
 * 再生区間。`terminated: false` は `tts.playback_stopped` が来ないまま終わったことを示し、
 * `stop` はセッション終端（または次の再生開始）で代用する。
 *
 * 未終端の再生を捨ててはいけない —— 捨てると **barge-in の最悪の失敗（再生が全く止まらない）**が
 * 「検出率 0」ではなく「近端 onset がゼロ件」として現れ、指標から消えてしまう。
 */
export type VoiceEvalPlaybackWindow = {
  start: number;
  stop: number;
  reason: VoiceEvalPlaybackStopReason | 'unterminated';
  terminated: boolean;
};

function sessionEndMs(events: readonly VoiceEvalEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.t), 0);
}

/** 再生区間（playback_start → playback_stopped）を時刻順に取り出す。未終端も含む。 */
export function playbackWindows(events: readonly VoiceEvalEvent[]): VoiceEvalPlaybackWindow[] {
  const sorted = sortVoiceEvalEvents(events);
  const endOfSession = sessionEndMs(sorted);
  const windows: VoiceEvalPlaybackWindow[] = [];
  let start: number | null = null;

  for (const event of sorted) {
    if (event.type === 'tts.playback_start') {
      // 停止されないまま次の再生が始まった場合も、未終端として確定させる。
      if (start !== null) windows.push({ start, stop: event.t, reason: 'unterminated', terminated: false });
      start = event.t;
    } else if (event.type === 'tts.playback_stopped' && start !== null) {
      windows.push({ start, stop: event.t, reason: event.reason, terminated: true });
      start = null;
    }
  }
  if (start !== null) windows.push({ start, stop: endOfSession, reason: 'unterminated', terminated: false });

  return windows;
}

/** 指定時刻に音声を再生中だったか（区間の内側のみ。境界は再生中とみなさない）。 */
export function isPlaybackActiveAt(events: readonly VoiceEvalEvent[], t: number): boolean {
  return playbackWindows(events).some((w) => t > w.start && t < w.stop);
}

export type VoiceEvalNearEndObservation = {
  /** 観測の通番（デバッグ・帰属関数の内部利用向け。正解ラベルの帰属には使わない）。 */
  observationIndex: number;
  t: number;
  window: VoiceEvalPlaybackWindow;
};

/** 再生中に落ちた `audio.onset`（= 近端発話の観測）を時刻順に返す。 */
export function observedNearEndOnsets(events: readonly VoiceEvalEvent[]): VoiceEvalNearEndObservation[] {
  const windows = playbackWindows(events);
  const result: VoiceEvalNearEndObservation[] = [];
  for (const event of sortVoiceEvalEvents(events)) {
    if (event.type !== 'audio.onset') continue;
    const window = windows.find((w) => event.t > w.start && event.t < w.stop);
    if (window) result.push({ observationIndex: result.length, t: event.t, window });
  }
  return result;
}

/** 近端発話の観測件数。 */
export function countNearEndOnsets(events: readonly VoiceEvalEvent[]): number {
  return observedNearEndOnsets(events).length;
}

function validateEvent(event: VoiceEvalEvent, index: number, errors: string[]): void {
  const where = `events[${index}]`;

  if (typeof event?.t !== 'number' || !Number.isFinite(event.t) || event.t < 0) {
    errors.push(`${where}: t は 0 以上の有限数である必要がある (received: ${String(event?.t)})`);
  }
  if (typeof event?.turnIndex !== 'number' || !Number.isInteger(event.turnIndex) || event.turnIndex < 0) {
    errors.push(`${where}: turnIndex は 0 以上の整数である必要がある`);
  }
  if (!EVENT_TYPES.includes(event?.type)) {
    errors.push(`${where}: 未知のイベント種別 '${String(event?.type)}'`);
    return;
  }

  const record = event as unknown as Record<string, unknown>;
  for (const field of FORBIDDEN_EVENT_FIELDS) {
    if (field in record) {
      errors.push(
        `${where}: '${field}' はイベントに含められない（生音声はスキーマ外。実音声の取り扱いは明示的同意・匿名化・ライセンスが必要）`,
      );
    }
  }

  switch (event.type) {
    case 'stt.partial':
      if (typeof event.text !== 'string') errors.push(`${where}: stt.partial には text が必要`);
      if (typeof event.stable !== 'boolean') {
        errors.push(`${where}: stt.partial には stable (boolean) が必要（UI 確定 partial の測定起点）`);
      }
      break;
    case 'stt.final':
    case 'tts.request':
      if (typeof event.text !== 'string') errors.push(`${where}: ${event.type} には text が必要`);
      break;
    case 'turn.committed':
      if (typeof event.text !== 'string') errors.push(`${where}: turn.committed には text が必要`);
      if (!['silence', 'rule', 'vad', 'manual'].includes(event.trigger)) {
        errors.push(`${where}: turn.committed の trigger が不正 '${String(event.trigger)}'`);
      }
      break;
    case 'tts.playback_stopped':
      if (!['completed', 'barge_in', 'cancelled', 'error'].includes(event.reason)) {
        errors.push(`${where}: tts.playback_stopped の reason が不正 '${String(event.reason)}'`);
      }
      break;
    case 'vrm.viseme_applied':
      if (typeof event.audioTimestampMs !== 'number' || event.audioTimestampMs < 0) {
        errors.push(`${where}: vrm.viseme_applied には 0 以上の audioTimestampMs が必要`);
      }
      break;
    case 'transport.reconnecting':
      if (!Number.isInteger(event.attempt) || event.attempt < 1) {
        errors.push(`${where}: transport.reconnecting の attempt は 1 以上の整数である必要がある`);
      }
      break;
    case 'transport.disconnected':
      if (!['client', 'server', 'network', 'timeout'].includes(event.reason)) {
        errors.push(`${where}: transport.disconnected の reason が不正 '${String(event.reason)}'`);
      }
      break;
    case 'transport.stats':
      if (typeof event.droppedPackets !== 'number' || event.droppedPackets < 0) {
        errors.push(`${where}: transport.stats には 0 以上の droppedPackets が必要`);
      }
      if (typeof event.jitterMs !== 'number' || event.jitterMs < 0) {
        errors.push(`${where}: transport.stats には 0 以上の jitterMs が必要`);
      }
      break;
    case 'error':
    case 'session.aborted':
      if (!['transport', 'stt', 'tts', 'turn', 'entity', 'vrm'].includes(event.stage)) {
        errors.push(`${where}: ${event.type} の stage が不正 '${String(event.stage)}'`);
      }
      if (typeof event.code !== 'string' || event.code.length === 0) {
        errors.push(`${where}: ${event.type} には code（短い識別子）が必要`);
      } else if (event.code.length > 64) {
        errors.push(`${where}: ${event.type} の code が長すぎる（例外メッセージをそのまま入れない）`);
      }
      break;
    case 'entity.resolved': {
      if (!Array.isArray(event.candidates)) {
        errors.push(`${where}: entity.resolved には candidates 配列が必要`);
        break;
      }
      const scores = event.candidates.map((c) => c.score);
      const isDescending = scores.every((score, i) => i === 0 || score <= (scores[i - 1] ?? Infinity));
      if (!isDescending) {
        errors.push(`${where}: entity.resolved の candidates は score の降順である必要がある（Top1/Top3 が順序依存）`);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * セッションがスキーマに適合しているか検証する。**例外を投げず** 全エラーを集めて返す
 * （#369〜#372 の実装が自分のテストで一括確認できるようにするため）。
 *
 * 検証するのは**構造の正しさ**だけで、provider の性能は見ない。性能の劣化（onset の取りこぼし・
 * ターン脱落など）は指標として計測されるべきものであり、ここで fatal にしてはいけない。
 */
export function validateVoiceEvalSession(session: VoiceEvalSession): VoiceEvalValidation {
  const errors: string[] = [];

  if (session.schemaVersion !== VOICE_EVAL_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion ${String(session.schemaVersion)} は解釈できない（このハーネスは ${VOICE_EVAL_SCHEMA_VERSION} と完全一致のみ受け付ける）`,
    );
  }
  if (!session.sessionId) errors.push('sessionId が空');
  if (!session.providers?.stt || !session.providers?.tts || !session.providers?.turn) {
    errors.push('providers は stt / tts / turn を全て持つ必要がある（provider 比較の軸になるため）');
  }
  if (!Array.isArray(session.events)) {
    errors.push('events が配列でない');
    return { valid: false, errors };
  }

  let previousT = -Infinity;
  let synthesisRequested = false;
  session.events.forEach((event, index) => {
    validateEvent(event, index, errors);
    if (typeof event?.t === 'number') {
      if (event.t < previousT) {
        errors.push(`events[${index}]: t が単調増加していない (${previousT} → ${event.t})。単一時計源で記録すること`);
      }
      previousT = event.t;
    }
    if (event?.type === 'tts.request') synthesisRequested = true;
    if (event?.type === 'tts.playback_start' && !synthesisRequested) {
      errors.push(`events[${index}]: 先行する tts.request が無いまま tts.playback_start が現れた`);
    }
  });

  // 注: 「正解にあるターンのイベントが 1 つも無い」ことは検証しない。ターンの脱落・セッションの
  // 中断は provider の**性能の失敗**であり、`missedEndRate` や `abortedSessionRate` として
  // 計測されるべきもの。ここで fatal にすると、近端発話の通番と同じ誤り（実装の壊れが
  // 「計測の壊れ」として現れる）を繰り返すことになる。

  const stimulusIds = new Set<string>();
  for (const stimulus of session.groundTruth?.nearEndStimuli ?? []) {
    if (!stimulus.id) errors.push('groundTruth.nearEndStimuli: id が空');
    if (stimulusIds.has(stimulus.id)) {
      errors.push(`groundTruth.nearEndStimuli: id '${stimulus.id}' が重複している`);
    }
    stimulusIds.add(stimulus.id);
    if (typeof stimulus.atMs !== 'number' || stimulus.atMs < 0) {
      errors.push(`groundTruth.nearEndStimuli['${stimulus.id}']: atMs は 0 以上である必要がある`);
    }
    if (typeof stimulus.toleranceMs !== 'number' || stimulus.toleranceMs <= 0) {
      errors.push(`groundTruth.nearEndStimuli['${stimulus.id}']: toleranceMs は正の数である必要がある`);
    }
    if (!['interruption', 'backchannel', 'echo', 'environment'].includes(stimulus.label)) {
      errors.push(`groundTruth.nearEndStimuli['${stimulus.id}']: label が不正 '${String(stimulus.label)}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}
