import { describe, it, expect } from 'vitest';
import { emptyQueueState, enqueueChunk, dequeueChunk, type VoiceTransportQueueLimits } from './queue';

const limits: VoiceTransportQueueLimits = { maxChunks: 3, maxBytes: 300, dropPolicy: 'drop-oldest' };

function chunk(seq: number, byteLength = 100) {
  return { seq, t: seq * 20, byteLength };
}

describe('enqueueChunk / dequeueChunk', () => {
  it('enqueues chunks in order under the limit', () => {
    let state = emptyQueueState();
    const r1 = enqueueChunk(state, chunk(1), limits);
    expect(r1.outcome).toBe('enqueued');
    state = r1.state;
    const r2 = enqueueChunk(state, chunk(2), limits);
    expect(r2.outcome).toBe('enqueued');
    expect(r2.state.chunks.map((c) => c.seq)).toEqual([1, 2]);
    expect(r2.state.totalBytes).toBe(200);
  });

  it('dequeues FIFO', () => {
    let state = emptyQueueState();
    state = enqueueChunk(state, chunk(1), limits).state;
    state = enqueueChunk(state, chunk(2), limits).state;
    const d1 = dequeueChunk(state);
    expect(d1?.chunk.seq).toBe(1);
    state = d1!.state;
    expect(state.chunks.map((c) => c.seq)).toEqual([2]);
    expect(state.totalBytes).toBe(100);
  });

  it('dequeue on an empty queue returns null (does not throw)', () => {
    expect(dequeueChunk(emptyQueueState())).toBeNull();
  });

  it('never grows chunk count beyond maxChunks under drop-oldest — memory/queue stays bounded', () => {
    let state = emptyQueueState();
    for (let seq = 1; seq <= 100; seq += 1) {
      state = enqueueChunk(state, chunk(seq), limits).state;
      expect(state.chunks.length).toBeLessThanOrEqual(limits.maxChunks);
      expect(state.totalBytes).toBeLessThanOrEqual(limits.maxBytes);
    }
    // 直近 maxChunks 件だけが残る（古いものから捨てる）。
    expect(state.chunks.map((c) => c.seq)).toEqual([98, 99, 100]);
  });

  it('drop-oldest reports the dropped seq so callers can count drops for transport.stats', () => {
    let state = emptyQueueState();
    state = enqueueChunk(state, chunk(1), limits).state;
    state = enqueueChunk(state, chunk(2), limits).state;
    state = enqueueChunk(state, chunk(3), limits).state; // now at maxChunks=3
    const r = enqueueChunk(state, chunk(4), limits);
    if (r.outcome !== 'dropped') throw new Error(`expected 'dropped', got '${r.outcome}'`);
    expect(r.droppedSeq).toBe(1);
    expect(r.state.chunks.map((c) => c.seq)).toEqual([2, 3, 4]);
  });

  it('drop-newest keeps existing chunks and discards the incoming one', () => {
    const dropNewestLimits: VoiceTransportQueueLimits = { ...limits, dropPolicy: 'drop-newest' };
    let state = emptyQueueState();
    state = enqueueChunk(state, chunk(1), dropNewestLimits).state;
    state = enqueueChunk(state, chunk(2), dropNewestLimits).state;
    state = enqueueChunk(state, chunk(3), dropNewestLimits).state;
    const r = enqueueChunk(state, chunk(4), dropNewestLimits);
    if (r.outcome !== 'dropped') throw new Error(`expected 'dropped', got '${r.outcome}'`);
    expect(r.droppedSeq).toBe(4);
    expect(r.state.chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it('reject policy refuses the incoming chunk without mutating state', () => {
    const rejectLimits: VoiceTransportQueueLimits = { ...limits, dropPolicy: 'reject' };
    let state = emptyQueueState();
    state = enqueueChunk(state, chunk(1), rejectLimits).state;
    state = enqueueChunk(state, chunk(2), rejectLimits).state;
    state = enqueueChunk(state, chunk(3), rejectLimits).state;
    const r = enqueueChunk(state, chunk(4), rejectLimits);
    expect(r.outcome).toBe('rejected');
    expect(r.state).toBe(state); // 参照同一 — 変更なし
  });

  it('enforces maxBytes independently of maxChunks (large chunk triggers drop before count limit)', () => {
    const byteLimits: VoiceTransportQueueLimits = { maxChunks: 100, maxBytes: 250, dropPolicy: 'drop-oldest' };
    let state = emptyQueueState();
    state = enqueueChunk(state, chunk(1, 100), byteLimits).state;
    state = enqueueChunk(state, chunk(2, 100), byteLimits).state;
    const r = enqueueChunk(state, chunk(3, 100), byteLimits); // 300 > 250 → must drop to make room
    expect(r.state.totalBytes).toBeLessThanOrEqual(250);
    expect(r.state.chunks.some((c) => c.seq === 3)).toBe(true);
  });

  it('never returns totalBytes out of sync with the sum of chunk byteLengths', () => {
    let state = emptyQueueState();
    for (let seq = 1; seq <= 20; seq += 1) {
      state = enqueueChunk(state, chunk(seq, 17), limits).state;
      const sum = state.chunks.reduce((acc, c) => acc + c.byteLength, 0);
      expect(state.totalBytes).toBe(sum);
    }
  });
});
