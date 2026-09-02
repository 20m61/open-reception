import { describe, expect, it, vi } from 'vitest';
import type { MotionObservation } from '@/domain/avatar/motion-state';
import { createMotionPlayer, type MotionAction } from './motion-player';

/**
 * `.vrma` 切替の競合制御を three 無しで縛る。
 * 以前は `VrmAvatarViewer` の effect 内に閉じていて、「後発の要求が勝つ」「空 URL で
 * 再生中を止める」「破棄後に遅れて届いた読込を捨てる」がどれもテストされていなかった。
 */
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(opts: { vrmLoaded?: boolean } = {}) {
  const pending = new Map<string, Deferred<string | undefined>>();
  const observed: MotionObservation[] = [];
  const actions: Array<MotionAction & { anim: string; fadedOut: number[] }> = [];
  const player = createMotionPlayer<string>({
    vrmLoaded: opts.vrmLoaded ?? true,
    load: (url) => {
      const d = deferred<string | undefined>();
      pending.set(url, d);
      return d.promise;
    },
    play: (anim) => {
      const action = {
        anim,
        fadedOut: [] as number[],
        fadeOut(d: number) {
          this.fadedOut.push(d);
        },
      };
      actions.push(action);
      return action;
    },
    observe: (o) => observed.push(o),
    fadeSec: 0.3,
  });
  return { player, pending, observed, actions };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createMotionPlayer', () => {
  it('読込 → 再生: loading の後 playing を観測し、play に VRMAnimation を渡す', async () => {
    const h = harness();
    const req = h.player.request('/a.vrma');
    expect(h.observed).toEqual([{ state: 'loading' }]);
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await req;
    expect(h.observed.at(-1)).toEqual({ state: 'playing' });
    expect(h.actions.map((a) => a.anim)).toEqual(['anim-a']);
  });

  it('切替: 新しいモーションを再生してから前のを fadeOut する', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    const b = h.player.request('/b.vrma');
    h.pending.get('/b.vrma')!.resolve('anim-b');
    await b;
    expect(h.actions.map((x) => x.anim)).toEqual(['anim-a', 'anim-b']);
    expect(h.actions[0]!.fadedOut).toEqual([0.3]);
    expect(h.actions[1]!.fadedOut).toEqual([]);
  });

  it('後発の要求が先に解決したら、先発の遅れた読込は再生も観測もしない', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    const b = h.player.request('/b.vrma');
    h.pending.get('/b.vrma')!.resolve('anim-b');
    await b;
    const observedBefore = h.observed.length;
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    await flush();
    expect(h.actions.map((x) => x.anim)).toEqual(['anim-b']);
    expect(h.observed.length).toBe(observedBefore);
    expect(h.player.isPlaying()).toBe(true);
  });

  it('空 URL は再生中を止め、飛行中の読込を無効化し、none を観測する', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    const b = h.player.request('/b.vrma');
    await h.player.request(undefined);
    expect(h.actions[0]!.fadedOut).toEqual([0.3]);
    expect(h.observed.at(-1)).toEqual({ state: 'none' });
    expect(h.player.isPlaying()).toBe(false);
    // 飛行中だった b が後から届いても復活しない。
    h.pending.get('/b.vrma')!.resolve('anim-b');
    await b;
    expect(h.actions.map((x) => x.anim)).toEqual(['anim-a']);
    expect(h.player.isPlaying()).toBe(false);
  });

  it('読込失敗: 前のモーションを止めて failed:load-error を観測する（黙らない）', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    const b = h.player.request('/b.vrma');
    h.pending.get('/b.vrma')!.reject(new Error('404'));
    await b;
    expect(h.observed.at(-1)).toEqual({ state: 'failed', failure: 'load-error' });
    expect(h.actions[0]!.fadedOut).toEqual([0.3]);
    expect(h.player.isPlaying()).toBe(false);
  });

  it('VRMAnimation が入っていない: failed:no-animation を観測し、再生しない', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.pending.get('/a.vrma')!.resolve(undefined);
    await a;
    expect(h.observed.at(-1)).toEqual({ state: 'failed', failure: 'no-animation' });
    expect(h.actions).toHaveLength(0);
  });

  it('再生中に VRMAnimation の無い .vrma へ切替えたら、前のモーションを止めて failed を報告する', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    const b = h.player.request('/empty.vrma');
    h.pending.get('/empty.vrma')!.resolve(undefined);
    await b;
    // `failed:*` を見た運用者は「再生されていない」と読む。前のを回し続けると嘘になる。
    expect(h.actions[0]!.fadedOut).toEqual([0.3]);
    expect(h.player.isPlaying()).toBe(false);
    expect(h.observed.at(-1)).toEqual({ state: 'failed', failure: 'no-animation' });
  });

  it('dispose 後の request は読込も観測もしない', async () => {
    const h = harness();
    h.player.dispose();
    await h.player.request('/a.vrma');
    await h.player.request(undefined);
    expect(h.pending.size).toBe(0);
    expect(h.observed).toEqual([]);
  });

  it('VRM 未読込: 読込を試みず failed:no-vrm を観測する', async () => {
    const h = harness({ vrmLoaded: false });
    await h.player.request('/a.vrma');
    expect(h.observed).toEqual([{ state: 'failed', failure: 'no-vrm' }]);
    expect(h.pending.size).toBe(0);
  });

  it('dispose 後に届いた読込は再生も観測もしない', async () => {
    const h = harness();
    const a = h.player.request('/a.vrma');
    h.player.dispose();
    h.pending.get('/a.vrma')!.resolve('anim-a');
    await a;
    expect(h.actions).toHaveLength(0);
    expect(h.observed).toEqual([{ state: 'loading' }]);
  });

  it('play が投げても failed:load-error として報告する', async () => {
    const observed: MotionObservation[] = [];
    const player = createMotionPlayer<string>({
      vrmLoaded: true,
      load: async () => 'anim',
      play: () => {
        throw new Error('clip mismatch');
      },
      observe: (o) => observed.push(o),
    });
    await player.request('/a.vrma');
    expect(observed.at(-1)).toEqual({ state: 'failed', failure: 'load-error' });
    expect(player.isPlaying()).toBe(false);
  });

  it('observe は同期的に呼ばれる（vi.fn で固定）', async () => {
    const observe = vi.fn();
    const player = createMotionPlayer<string>({
      vrmLoaded: true,
      load: async () => 'anim',
      play: () => ({ fadeOut: () => {} }),
      observe,
    });
    const p = player.request('/a.vrma');
    expect(observe).toHaveBeenCalledWith({ state: 'loading' });
    await p;
    expect(observe).toHaveBeenLastCalledWith({ state: 'playing' });
  });
});
