import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENCE_CONFIG } from '@/domain/presence/state';
import {
  INITIAL_ATTRACT_DETECTOR_STATE,
  resumeAttractDetector,
  stepAttractDetector,
} from './attract-detector';

const cfg = DEFAULT_PRESENCE_CONFIG;
const HIGH_MOTION = cfg.motionEnterThreshold + 0.5;
const LOW_MOTION = cfg.motionEnterThreshold - 0.05;

describe('stepAttractDetector (#362)', () => {
  it('通行人の横切り（単発モーション）だけでは ATTRACT へ達しない', () => {
    const r1 = stepAttractDetector(INITIAL_ATTRACT_DETECTOR_STATE, HIGH_MOTION, cfg);
    expect(r1.attractSignal).toBe(false);
    expect(r1.state.presence).toBe('CANDIDATE');

    // 直後にモーションが止む（横切り）→ candidateTicks はリセットされる
    const r2 = stepAttractDetector(r1.state, LOW_MOTION, cfg);
    expect(r2.attractSignal).toBe(false);
  });

  it('一定時間（連続 tick）滞在すると ATTRACT シグナルを一度だけ返す（受付は開始しない）', () => {
    let state = INITIAL_ATTRACT_DETECTOR_STATE;
    let signaled = false;
    for (let i = 0; i < 5 && !signaled; i++) {
      const r = stepAttractDetector(state, HIGH_MOTION, cfg);
      state = r.state;
      signaled = r.attractSignal;
    }
    expect(signaled).toBe(true);
    expect(state.presence).toBe('ATTRACT');
    expect(state.attractSignaled).toBe(true);
  });

  it('ATTRACT シグナル後は attractSignaled が立ち、追加のモーションを無視する（多重発火防止）', () => {
    let state = INITIAL_ATTRACT_DETECTOR_STATE;
    for (let i = 0; i < 2; i++) {
      state = stepAttractDetector(state, HIGH_MOTION, cfg).state;
    }
    expect(state.attractSignaled).toBe(true);

    const after = stepAttractDetector(state, HIGH_MOTION, cfg);
    expect(after.attractSignal).toBe(false);
    expect(after.state).toBe(state); // 完全に無視（参照も変えない）
  });

  it('resumeAttractDetector で初期状態へ戻し、再検知できるようにする（ATTRACT タイムアウト/再開）', () => {
    let state = INITIAL_ATTRACT_DETECTOR_STATE;
    for (let i = 0; i < 2; i++) {
      state = stepAttractDetector(state, HIGH_MOTION, cfg).state;
    }
    expect(state.attractSignaled).toBe(true);

    const resumed = resumeAttractDetector();
    expect(resumed).toEqual(INITIAL_ATTRACT_DETECTOR_STATE);

    const r = stepAttractDetector(resumed, HIGH_MOTION, cfg);
    expect(r.state.presence).toBe('CANDIDATE');
  });

  it('カスタム ticksToAttract を尊重する', () => {
    const state = INITIAL_ATTRACT_DETECTOR_STATE;
    const r1 = stepAttractDetector(state, HIGH_MOTION, cfg, 1);
    expect(r1.attractSignal).toBe(true);
  });
});
