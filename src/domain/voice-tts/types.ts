/**
 * TTS（音声出力）基盤の共通型・契約 (issue #371)。
 *
 * 位置づけ: 本モジュールは純データ型と provider/controller の **契約 (interface)** のみを持つ。
 * `src/domain/voice-transport/` (#369) と同じ流儀 —— I/O（Polly 呼び出し・キャッシュ永続化・
 * ブラウザ音声再生）は `src/lib/voice-tts/` が担う。計測イベントへの橋渡しは `eval-bridge.ts`
 * （#365 契約）。
 *
 * `src/lib/voice/`（既存, #103・#28）との違い: あちらは音声**設定**（ttsEnabled/voiceId/rate/
 * locale 別 voice 上書き等）の真実源であり、音声パイプラインそのものではない。本モジュールは
 * その設定値を `TtsRequest` の各フィールドとして受け取る側であり、混同しない
 * （`docs/loop-queue.md` 落とし穴節）。
 */

/** Amazon Polly の engine 種別に対応する語彙（provider 非依存の論理名として保つ）。 */
export type TtsEngine = 'standard' | 'neural' | 'generative';

/**
 * キャッシュキーの構成要素 (issue #371 契約: `locale + voice + engine + rate + speechText +
 * lexiconVersion`)。
 */
export type TtsCacheKeyParts = {
  locale: string;
  voice: string;
  engine: TtsEngine;
  rate: number;
  /** 発音用テキスト（displayText ではない — `resolveSpeechText` で導出したもの）。 */
  speechText: string;
  /** Polly カスタム語彙（発音辞書）の版数。変更でキャッシュを無効化する。 */
  lexiconVersion: string;
};

/**
 * キャッシュキーを組み立てる。区切り文字の単純連結（`locale + '|' + voice + ...`）は、
 * フィールド境界がずれても連結結果が一致してしまう衝突を構造的に防げない
 * （例: locale='ja', voice='-JPTakumi' と locale='ja-JP', voice='Takumi'）。
 * 各要素を長さプレフィックス付きで持つことで、この種の衝突をなくす。
 */
export function buildTtsCacheKey(parts: TtsCacheKeyParts): string {
  const enc = (s: string): string => `${s.length}:${s}`;
  return [
    enc(parts.locale),
    enc(parts.voice),
    enc(parts.engine),
    enc(String(parts.rate)),
    enc(parts.speechText),
    enc(parts.lexiconVersion),
  ].join('|');
}

/**
 * 画面表示文と発音用文の分離 (issue #371 AC)。人名の読み・丁寧表現の違いを、意味上のキー
 * （呼び出し側が持つ `semanticKey`）を共有しつつ表現だけ分けられるようにする。
 * `src/domain/reception/ui-contract.ts` の `message.displayText/speechText`（#361）と
 * 同じ語彙を踏襲する（表示/発音分離のキー自体は #361 で既に契約化済み）。
 */
export type TtsUtteranceText = {
  /** 画面表示用（例: 漢字表記の人名、句読点付きの丁寧文）。 */
  displayText: string;
  /** 発音用（例: 読み仮名、Polly 向けに整形した文）。省略時は displayText を発音にも使う。 */
  speechText?: string;
};

/** speechText が空/未設定なら displayText へフォールバックする。 */
export function resolveSpeechText(text: TtsUtteranceText): string {
  return text.speechText && text.speechText.trim() ? text.speechText : text.displayText;
}

/** 1 発話（utterance）の合成リクエスト。 */
export type TtsRequest = {
  /** utterance 単位の停止・破棄・abort を紐づける識別子。 */
  utteranceId: string;
  locale: string;
  voice: string;
  engine: TtsEngine;
  rate: number;
  lexiconVersion: string;
  text: TtsUtteranceText;
  /**
   * 定型文/動的文の分類キー（例 'guidance.idle'、'dynamic.staffCalled'）。事前生成ジョブの対象
   * 抽出（`cache.ts`）に使う。省略可（アドホックな動的文は未分類のままキャッシュだけされる）。
   */
  semanticKey?: string;
};

/** キャッシュキーを TtsRequest から導出する（speechText は resolveSpeechText 経由）。 */
export function ttsRequestCacheKey(request: TtsRequest): string {
  return buildTtsCacheKey({
    locale: request.locale,
    voice: request.voice,
    engine: request.engine,
    rate: request.rate,
    speechText: resolveSpeechText(request.text),
    lexiconVersion: request.lexiconVersion,
  });
}

/**
 * 合成音声の 1 チャンク。実バイト列（`ArrayBuffer` 等）は `src/lib/voice-tts/` 側の拡張型が持つ
 * （`src/domain/voice-transport/queue.ts` と同じ方針 —— domain 層は会計に必要な最小フィールドの
 * みを扱い、実データは lib 層で拡張する）。
 */
export type TtsAudioChunk = {
  utteranceId: string;
  /** 単調増加するチャンク通番。 */
  seq: number;
  /** utterance 音声内の相対 ms（Polly Speech Marks や viseme タイムラインと同じ基準）。 */
  audioTimestampMs: number;
  byteLength: number;
  /** このチャンクが utterance の最終チャンクか。 */
  final: boolean;
};

/**
 * Provider 側の契約 (issue #371 契約案)。生成の**開始**と**中止**のみを持つ —— 再生の停止・
 * キュー破棄は端末側の責務（`TtsPlaybackController`）であり、ここに混ぜない
 * （設計方針: 「Provider側の生成中止と、端末側の再生停止・キュー破棄を別責務にする」）。
 */
export interface StreamingTtsProvider {
  synthesize(request: TtsRequest): AsyncIterable<TtsAudioChunk>;
  /** 生成中の utterance を中止する。実装によっては no-op（省略可）。 */
  abortGeneration?(utteranceId: string): Promise<void>;
}

/**
 * 端末側の再生キュー制御の契約 (issue #371 契約案)。
 *  - `stopPlayback`: 現在再生中の音声を即時停止する（barge-in 等）。
 *  - `discardQueuedAudio`: まだ再生されていないキュー内の音声を破棄する（stopPlayback とは
 *    別責務 —— 現在再生中の音声には触れない）。
 */
export interface TtsPlaybackController {
  enqueue(chunk: TtsAudioChunk): void;
  stopPlayback(utteranceId: string): void;
  discardQueuedAudio(utteranceId: string): void;
}

/** 音声キャッシュの 1 エントリ。実バイト列の格納先は opaque な `audioRef` として持つ（境界は
 * `docs/adr/0002-voice-tts-cache-boundaries.md` 参照。この increment は境界の interface のみ）。 */
export type TtsCacheEntry = {
  audioRef: string;
  createdAt: number;
};

/**
 * 音声キャッシュの境界 interface。S3/CloudFront/Service Worker/IndexedDB のいずれで実装しても
 * 呼び出し側は変わらない（`docs/adr/0002-voice-tts-cache-boundaries.md`）。この increment では
 * `src/lib/voice-tts/cache-store.ts` のメモリ実装のみを提供する。
 */
export interface TtsCache {
  get(key: string): TtsCacheEntry | undefined;
  set(key: string, entry: TtsCacheEntry): void;
  has(key: string): boolean;
}
