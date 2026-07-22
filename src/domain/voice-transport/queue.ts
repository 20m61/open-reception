/**
 * 送信待ちチャンクの有界キュー (issue #369)。
 *
 * backpressure（サーバ/回線が追いつかない）時にメモリが無制限に増えないことを保証する
 * 純データ構造。ネットワーク・タイマーなど I/O は持たない — 呼び出し側（lib 層の transport
 * client）がこの上に実際の送信ループを組み立てる。
 *
 * `C`（chunk 型）はジェネリクスにしてある: ここでの会計（順序・バイト数・上限判定）に必要な
 * 最小フィールドだけを要求し、呼び出し側（`lib/voice-transport/client.ts`）が実際の音声
 * バイト列（`ArrayBuffer` 等）を持つ拡張型をそのまま積めるようにするため
 * （会計用メタデータと実データを別々の Map で二重管理させない）。
 */

export type VoiceTransportQueuedChunk = {
  /** 単調増加する送信通番（ドロップ検出・順序検証に使う）。 */
  seq: number;
  /** キャプチャ開始からの相対 ms。 */
  t: number;
  byteLength: number;
};

export type VoiceTransportQueueDropPolicy = 'drop-oldest' | 'drop-newest' | 'reject';

export type VoiceTransportQueueLimits = {
  /** キューに保持できる最大チャンク数。 */
  maxChunks: number;
  /** キューに保持できる合計バイト数。 */
  maxBytes: number;
  dropPolicy: VoiceTransportQueueDropPolicy;
};

export type VoiceTransportQueueState<C extends VoiceTransportQueuedChunk = VoiceTransportQueuedChunk> = {
  chunks: readonly C[];
  totalBytes: number;
};

export function emptyQueueState<
  C extends VoiceTransportQueuedChunk = VoiceTransportQueuedChunk,
>(): VoiceTransportQueueState<C> {
  return { chunks: [], totalBytes: 0 };
}

export type VoiceTransportEnqueueResult<C extends VoiceTransportQueuedChunk = VoiceTransportQueuedChunk> =
  | { outcome: 'enqueued'; state: VoiceTransportQueueState<C> }
  | { outcome: 'dropped'; state: VoiceTransportQueueState<C>; droppedSeq: number }
  | { outcome: 'rejected'; state: VoiceTransportQueueState<C> };

/**
 * チャンクをキューへ積む。上限を超える場合は `limits.dropPolicy` に従う:
 *  - `drop-oldest`: 先頭（最古）から捨てて新規チャンクを積む（既定・低遅延優先）。
 *  - `drop-newest`: 既存を保ったまま新規チャンクを捨てる（順序保持優先）。
 *  - `reject`: 新規チャンクを積まず、状態も変更しない（呼び出し側に即座にバックオフさせたい場合）。
 *
 * どのポリシーでも `chunks.length <= maxChunks` と `totalBytes <= maxBytes` を関数の事後条件として
 * 保証する（無制限にメモリ・キューが増えない, issue #369 受け入れ条件）。
 */
export function enqueueChunk<C extends VoiceTransportQueuedChunk>(
  state: VoiceTransportQueueState<C>,
  chunk: C,
  limits: VoiceTransportQueueLimits,
): VoiceTransportEnqueueResult<C> {
  if (limits.dropPolicy === 'reject') {
    const wouldFit =
      state.chunks.length + 1 <= limits.maxChunks && state.totalBytes + chunk.byteLength <= limits.maxBytes;
    if (!wouldFit) return { outcome: 'rejected', state };
    const next: VoiceTransportQueueState<C> = {
      chunks: [...state.chunks, chunk],
      totalBytes: state.totalBytes + chunk.byteLength,
    };
    return { outcome: 'enqueued', state: next };
  }

  if (limits.dropPolicy === 'drop-newest') {
    const wouldFit =
      state.chunks.length + 1 <= limits.maxChunks && state.totalBytes + chunk.byteLength <= limits.maxBytes;
    if (!wouldFit) return { outcome: 'dropped', state, droppedSeq: chunk.seq };
    const next: VoiceTransportQueueState<C> = {
      chunks: [...state.chunks, chunk],
      totalBytes: state.totalBytes + chunk.byteLength,
    };
    return { outcome: 'enqueued', state: next };
  }

  // drop-oldest: 先頭から捨てながら追加後の状態を上限内に収める。
  let chunks = [...state.chunks, chunk];
  let totalBytes = state.totalBytes + chunk.byteLength;
  let droppedSeq: number | null = null;
  while ((chunks.length > limits.maxChunks || totalBytes > limits.maxBytes) && chunks.length > 1) {
    const [oldest, ...rest] = chunks;
    chunks = rest;
    totalBytes -= oldest!.byteLength;
    droppedSeq = oldest!.seq;
  }
  const next: VoiceTransportQueueState<C> = { chunks, totalBytes };
  if (droppedSeq !== null) return { outcome: 'dropped', state: next, droppedSeq };
  return { outcome: 'enqueued', state: next };
}

/** 先頭（最古）のチャンクを取り出す。空なら null。 */
export function dequeueChunk<C extends VoiceTransportQueuedChunk>(
  state: VoiceTransportQueueState<C>,
): { chunk: C; state: VoiceTransportQueueState<C> } | null {
  const [head, ...rest] = state.chunks;
  if (!head) return null;
  return { chunk: head, state: { chunks: rest, totalBytes: state.totalBytes - head.byteLength } };
}
