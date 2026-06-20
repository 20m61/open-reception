import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESENCE_CONFIG,
  isActive,
  presenceTransition,
  shouldRunFaceDetection,
  type PresenceConfig,
  type PresenceState,
} from './state';

const cfg: PresenceConfig = DEFAULT_PRESENCE_CONFIG;

describe('presence state machine', () => {
  it('立ち止まり→顔検出→タップで受付開始まで遷移する正常系', () => {
    let s: PresenceState = 'IDLE';
    let t = presenceTransition(s, { type: 'MOTION', motionLevel: 0.5 }, cfg);
    expect(t.state).toBe('CANDIDATE');
    expect(t.armTimer).toBe('candidateMax');
    s = t.state;

    t = presenceTransition(s, { type: 'FACE', faceDetected: true }, cfg);
    expect(t.state).toBe('ATTRACT');
    expect(t.armTimer).toBe('attractMax');
    s = t.state;

    t = presenceTransition(s, { type: 'TAP' }, cfg);
    expect(t.state).toBe('ACTIVE');
    expect(t.emit).toBe('session_started');
  });

  it('しきい値未満のモーションでは候補化しない（境界）', () => {
    const below = presenceTransition(
      'IDLE',
      { type: 'MOTION', motionLevel: cfg.motionEnterThreshold - 0.0001 },
      cfg,
    );
    expect(below.state).toBe('IDLE');

    const atThreshold = presenceTransition(
      'IDLE',
      { type: 'MOTION', motionLevel: cfg.motionEnterThreshold },
      cfg,
    );
    expect(atThreshold.state).toBe('CANDIDATE');
  });

  it('通行人の横切り: 顔が取れず candidateMax で IDLE に戻る（誤発火抑制）', () => {
    const noFace = presenceTransition('CANDIDATE', { type: 'FACE', faceDetected: false }, cfg);
    expect(noFace.state).toBe('CANDIDATE');

    const timedOut = presenceTransition(
      'CANDIDATE',
      { type: 'TIMEOUT', timer: 'candidateMax' },
      cfg,
    );
    expect(timedOut.state).toBe('IDLE');
  });

  it('ATTRACT 無操作は attractMax で IDLE に戻る', () => {
    const t = presenceTransition('ATTRACT', { type: 'TIMEOUT', timer: 'attractMax' }, cfg);
    expect(t.state).toBe('IDLE');
  });

  it('SESSION_ENDED でどの状態からも COOLDOWN へ入り、cooldownDone で IDLE へ戻る', () => {
    for (const s of ['ACTIVE', 'ATTRACT', 'IDLE'] as PresenceState[]) {
      const ended = presenceTransition(s, { type: 'SESSION_ENDED' }, cfg);
      expect(ended.state).toBe('COOLDOWN');
      expect(ended.armTimer).toBe('cooldownDone');
    }
    const done = presenceTransition('COOLDOWN', { type: 'TIMEOUT', timer: 'cooldownDone' }, cfg);
    expect(done.state).toBe('IDLE');
  });

  it('COOLDOWN 中のモーション/タップは無視して再発火しない', () => {
    expect(presenceTransition('COOLDOWN', { type: 'MOTION', motionLevel: 1 }, cfg).state).toBe(
      'COOLDOWN',
    );
    expect(presenceTransition('COOLDOWN', { type: 'TAP' }, cfg).state).toBe('COOLDOWN');
  });

  it('ACTIVE 中の追加モーション/タップはセッションを保護して無視する', () => {
    expect(presenceTransition('ACTIVE', { type: 'MOTION', motionLevel: 1 }, cfg).state).toBe(
      'ACTIVE',
    );
    expect(presenceTransition('ACTIVE', { type: 'TAP' }, cfg).state).toBe('ACTIVE');
    expect(presenceTransition('ACTIVE', { type: 'TAP' }, cfg).emit).toBeNull();
  });

  it('RESET はどの状態からでも IDLE に戻す（端末復帰）', () => {
    for (const s of ['CANDIDATE', 'ATTRACT', 'ACTIVE', 'COOLDOWN'] as PresenceState[]) {
      expect(presenceTransition(s, { type: 'RESET' }, cfg).state).toBe('IDLE');
    }
  });

  it('無関係な入力は現状維持（例外を投げない）', () => {
    expect(presenceTransition('IDLE', { type: 'TAP' }, cfg).state).toBe('IDLE');
    expect(presenceTransition('IDLE', { type: 'FACE', faceDetected: true }, cfg).state).toBe('IDLE');
    // 別状態向けの TIMEOUT は無視
    expect(
      presenceTransition('CANDIDATE', { type: 'TIMEOUT', timer: 'cooldownDone' }, cfg).state,
    ).toBe('CANDIDATE');
  });

  it('IDLE 中の遷移はサーバーイベントを発火しない（motion ログ爆発の抑制）', () => {
    const t = presenceTransition('IDLE', { type: 'MOTION', motionLevel: 1 }, cfg);
    expect(t.emit).toBeNull();
  });

  it('顔検出を起動してよいのは CANDIDATE の間だけ（低負荷方針）', () => {
    expect(shouldRunFaceDetection('CANDIDATE')).toBe(true);
    for (const s of ['IDLE', 'ATTRACT', 'ACTIVE', 'COOLDOWN'] as PresenceState[]) {
      expect(shouldRunFaceDetection(s)).toBe(false);
    }
  });

  it('isActive は ACTIVE のみ true', () => {
    expect(isActive('ACTIVE')).toBe(true);
    expect(isActive('ATTRACT')).toBe(false);
  });

  it('カスタム config のしきい値/タイマを尊重する', () => {
    const strict: PresenceConfig = { ...cfg, motionEnterThreshold: 0.9 };
    expect(presenceTransition('IDLE', { type: 'MOTION', motionLevel: 0.5 }, strict).state).toBe(
      'IDLE',
    );
    expect(presenceTransition('IDLE', { type: 'MOTION', motionLevel: 0.95 }, strict).state).toBe(
      'CANDIDATE',
    );
  });
});
