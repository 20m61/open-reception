import { describe, expect, it } from 'vitest';
import { motionStateAttribute, resolveMotionObservation } from './motion-state';

/**
 * モーション適用の**結果**の観測 (#578 増分 2)。
 *
 * 実機で「モーションが変」と言われたとき、**「再生されていない」のか「再生されているが
 * 見た目が変」なのか**を区別できるようにする。前者なら読込・アセット、後者なら版差・
 * リターゲット・カメラで、打つ手がまったく違う。
 */

describe('resolveMotionObservation', () => {
  it('モーション未指定は none（手続き的ポーズで動く正常状態）', () => {
    expect(resolveMotionObservation({ requestedUrl: undefined, vrmLoaded: true })).toEqual({
      state: 'none',
    });
    expect(resolveMotionObservation({ requestedUrl: '', vrmLoaded: true })).toEqual({
      state: 'none',
    });
  });

  it('読込が終わるまでは loading', () => {
    expect(resolveMotionObservation({ requestedUrl: '/m.vrma', vrmLoaded: true })).toEqual({
      state: 'loading',
    });
  });

  it('取得・パースに失敗したら load-error', () => {
    expect(
      resolveMotionObservation({ requestedUrl: '/m.vrma', vrmLoaded: true, loaded: false }),
    ).toEqual({ state: 'failed', failure: 'load-error' });
  });

  /**
   * **判定順が意味を持つ。** VRM が無ければ `.vrma` の中身に関わらず適用先が無い。
   * ここを後回しにすると「モーションのアセットが悪い」と誤診する。
   */
  it('VRM 未読込は no-vrm（モーション側の問題と誤診しない）', () => {
    expect(
      resolveMotionObservation({
        requestedUrl: '/m.vrma',
        vrmLoaded: false,
        loaded: true,
        hasAnimation: true,
      }),
    ).toEqual({ state: 'failed', failure: 'no-vrm' });
  });

  it('.vrma は読めたが VRMAnimation が無ければ no-animation', () => {
    expect(
      resolveMotionObservation({
        requestedUrl: '/m.vrma',
        vrmLoaded: true,
        loaded: true,
        hasAnimation: false,
      }),
    ).toEqual({ state: 'failed', failure: 'no-animation' });
  });

  it('すべて揃えば playing', () => {
    expect(
      resolveMotionObservation({
        requestedUrl: '/m.vrma',
        vrmLoaded: true,
        loaded: true,
        hasAnimation: true,
      }),
    ).toEqual({ state: 'playing' });
  });
});

describe('motionStateAttribute', () => {
  it('失敗は理由まで出す（次に何を調べるか分かるように）', () => {
    expect(motionStateAttribute({ state: 'failed', failure: 'no-animation' })).toBe(
      'failed:no-animation',
    );
    expect(motionStateAttribute({ state: 'failed', failure: 'no-vrm' })).toBe('failed:no-vrm');
    expect(motionStateAttribute({ state: 'failed', failure: 'load-error' })).toBe(
      'failed:load-error',
    );
  });

  it('失敗以外はそのまま', () => {
    expect(motionStateAttribute({ state: 'none' })).toBe('none');
    expect(motionStateAttribute({ state: 'loading' })).toBe('loading');
    expect(motionStateAttribute({ state: 'playing' })).toBe('playing');
  });
});

/**
 * **判定順** (#578 レビュー m8)。doc と実装が食い違っていたのを実装側へ揃えた。
 * 適用先（VRM）が無いことは読込結果と無関係に確定しているので最初に出す。
 */
describe('resolveMotionObservation / 判定順', () => {
  it('VRM 未読込は、.vrma の読込結果より優先して no-vrm を出す', () => {
    // 以前は load-error になり、より根本的な原因（適用先が無い）が隠れていた。
    expect(
      resolveMotionObservation({ requestedUrl: '/m.vrma', vrmLoaded: false, loaded: false }),
    ).toEqual({ state: 'failed', failure: 'no-vrm' });
  });

  it('VRM 未読込は、読込完了を待たずに no-vrm を出す', () => {
    // 待つと、.vrma が先に失敗した場合に no-vrm が永久に表へ出ない。
    expect(resolveMotionObservation({ requestedUrl: '/m.vrma', vrmLoaded: false })).toEqual({
      state: 'failed',
      failure: 'no-vrm',
    });
  });
});
