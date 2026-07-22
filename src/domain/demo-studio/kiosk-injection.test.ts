import { describe, expect, it, vi } from 'vitest';
import {
  deriveCallResponse,
  deriveCallStages,
  deriveKioskFlowProps,
  deriveOperatingStatus,
  deriveQrScanner,
  deriveSttAdapterFactory,
  deriveVoiceSession,
  wantsSyntheticVoice,
  type DemoScheduler,
  type DemoTimerHandle,
} from './kiosk-injection';
import { InjectableQrScanner } from '@/components/kiosk/qr-injection';
import { VoiceKioskStore } from '@/lib/voice-session/kiosk-store';
import { voiceCandidateToTarget } from '@/components/kiosk/voice-target-binding';
import type { DemoScenario } from './scenario';

function scenario(overrides: Partial<DemoScenario> = {}): DemoScenario {
  return {
    id: 'unit',
    name: 'unit',
    initialMode: 'reception',
    visitorInputs: [],
    simulatedResults: {},
    ...overrides,
  };
}

describe('deriveOperatingStatus (#363 営業時間外 注入)', () => {
  const NOW = Date.parse('2026-07-22T10:00:00.000Z');

  it('initialMode=out_of_hours は closed + 再開時刻サンプルを返す', () => {
    const status = deriveOperatingStatus(scenario({ initialMode: 'out_of_hours' }), NOW);
    expect(status).toBeDefined();
    expect(status?.state).toBe('closed');
    expect(status?.reopenAt).toBeDefined();
    expect(Date.parse(status!.reopenAt!)).toBeGreaterThan(NOW);
  });

  it('reopenAt は nowMs から決定論的に導出される（同じ nowMs は同じ結果）', () => {
    const a = deriveOperatingStatus(scenario({ initialMode: 'out_of_hours' }), NOW);
    const b = deriveOperatingStatus(scenario({ initialMode: 'out_of_hours' }), NOW);
    expect(a).toEqual(b);
  });

  it('emergencyContactLabel は PII を含まない汎用ラベル', () => {
    const status = deriveOperatingStatus(scenario({ initialMode: 'out_of_hours' }), NOW);
    expect(status?.emergencyContactLabel).toBeDefined();
    expect(status?.emergencyContactLabel).not.toMatch(/\d{2,4}-\d{2,4}-\d{4}/);
  });

  it('initialMode がそれ以外は undefined（fail-open・通常受付を止めない）', () => {
    expect(deriveOperatingStatus(scenario({ initialMode: 'reception' }), NOW)).toBeUndefined();
    expect(deriveOperatingStatus(scenario({ initialMode: 'signage' }), NOW)).toBeUndefined();
    expect(deriveOperatingStatus(scenario({ initialMode: 'qr' }), NOW)).toBeUndefined();
    expect(deriveOperatingStatus(scenario({ initialMode: 'attract' }), NOW)).toBeUndefined();
  });
});

describe('deriveSttAdapterFactory (#363 音声認識失敗→タッチ切替 注入)', () => {
  it('simulatedResults.stt 未指定は undefined（既定 MockSttAdapter を使わせる・非退行）', () => {
    expect(deriveSttAdapterFactory(scenario())).toBeUndefined();
  });

  it("stt: 'error' は候補ゼロを返す（実際の失敗UI→タッチ縮退の再現）", async () => {
    const factory = deriveSttAdapterFactory(scenario({ simulatedResults: { stt: 'error' } }));
    expect(factory).toBeDefined();
    const candidates = await factory!(['デモ 佐藤', 'デモ 鈴木']).listen();
    expect(candidates).toEqual([]);
  });

  it("stt: 'low_confidence' は 1 件のみの曖昧候補を返す（success と区別できる）", async () => {
    const factory = deriveSttAdapterFactory(
      scenario({ simulatedResults: { stt: 'low_confidence' } }),
    );
    const candidates = await factory!(['デモ 佐藤', 'デモ 鈴木', 'デモ 田中']).listen();
    expect(candidates).toHaveLength(1);
  });

  it("stt: 'success' は既定 MockSttAdapter と同じ規則（空白除外・最大3件）で返す", async () => {
    const factory = deriveSttAdapterFactory(scenario({ simulatedResults: { stt: 'success' } }));
    const candidates = await factory!(['さとう', '', '  ', 'すずき', 'たなか', 'いとう']).listen();
    expect(candidates).toEqual(['さとう', 'すずき', 'たなか']);
  });
});

describe('deriveQrScanner (#363 QR注入・カメラ不要)', () => {
  it('simulatedResults.qr 未指定は undefined（実カメラ経路のまま）', () => {
    expect(deriveQrScanner(scenario())).toBeUndefined();
  });

  it.each(['valid', 'expired', 'used', 'revoked'] as const)(
    "qr: '%s' は InjectableQrScanner を返し、start で非空 payload を即発火する",
    async (qr) => {
      const s = deriveQrScanner(scenario({ id: 'x', simulatedResults: { qr } }));
      expect(s).toBeInstanceOf(InjectableQrScanner);
      const results: string[] = [];
      await s!.start(
        (t) => results.push(t),
        () => {},
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.length).toBeGreaterThan(0);
    },
  );

  it('payload に PII/URL/制御文字を含まない（合成トークンのみ）', async () => {
    const s = deriveQrScanner(scenario({ id: 'my-scenario', simulatedResults: { qr: 'expired' } }));
    const results: string[] = [];
    await s!.start(
      (t) => results.push(t),
      () => {},
    );
    expect(results[0]).not.toMatch(/https?:|[<>]/);
  });
});

describe('deriveKioskFlowProps (#363 注入点統合)', () => {
  const NOW = Date.parse('2026-07-22T10:00:00.000Z');

  it('通常受付シナリオは全プロパティ undefined（既定挙動を変えない・非退行）', () => {
    const props = deriveKioskFlowProps(scenario({ initialMode: 'reception' }), NOW);
    expect(props.operatingStatus).toBeUndefined();
    expect(props.sttAdapterFactory).toBeUndefined();
    expect(props.qrScanner).toBeUndefined();
    expect(props.voiceSession).toBeUndefined();
  });

  it('音声成功シナリオは voiceSession（synthetic factory）を注入する', () => {
    const props = deriveKioskFlowProps(
      scenario({ visitorInputs: [{ mode: 'voice', value: '鈴木' }], simulatedResults: { stt: 'success' } }),
      NOW,
    );
    expect(props.voiceSession).toBeTypeOf('function');
  });

  it("stt:'error'（音声認識失敗→タッチ切替）は voiceSession を注入しない（失敗経路のまま・非退行）", () => {
    const props = deriveKioskFlowProps(
      scenario({ visitorInputs: [{ mode: 'voice', value: '鈴木' }], simulatedResults: { stt: 'error' } }),
      NOW,
    );
    expect(props.voiceSession).toBeUndefined();
    // 失敗系は従来どおり SttAdapter 側で候補ゼロ→タッチ縮退を再現する。
    expect(props.sttAdapterFactory).toBeDefined();
  });

  it('営業時間外シナリオは operatingStatus のみ注入する', () => {
    const props = deriveKioskFlowProps(scenario({ initialMode: 'out_of_hours' }), NOW);
    expect(props.operatingStatus?.state).toBe('closed');
    expect(props.sttAdapterFactory).toBeUndefined();
    expect(props.qrScanner).toBeUndefined();
  });

  it('stt+qr 同時指定シナリオは両方注入する', () => {
    const props = deriveKioskFlowProps(
      scenario({ simulatedResults: { stt: 'error', qr: 'valid' } }),
      NOW,
    );
    expect(props.sttAdapterFactory).toBeDefined();
    expect(props.qrScanner).toBeDefined();
  });
});

describe('deriveCallStages (#363 取次段階の導出)', () => {
  it('未指定/空は既定 no_answer 相当の単一段階', () => {
    expect(deriveCallStages(undefined)).toHaveLength(1);
    expect(deriveCallStages([])).toHaveLength(1);
  });

  it('連続未応答→応答（代理→部門代表）は各試行を1段階ずつ done で表す', () => {
    const stages = deriveCallStages(['no_answer', 'no_answer', 'answered']);
    expect(stages).toHaveLength(3);
    expect(stages.every((s) => s.status === 'done')).toBe(true);
  });

  it('最終手が failed のときは発信内訳（dial/ring/connect）へ展開し、末尾は pending', () => {
    const stages = deriveCallStages(['failed']);
    expect(stages.map((s) => s.key)).toEqual(['dial', 'ring', 'connect']);
    expect(stages[0]!.status).toBe('done');
    expect(stages[stages.length - 1]!.status).toBe('pending');
  });

  it('キーはすべて英数字/._- のみ（PII混入防止・call-stages.ts のキー許容パターンに適合）', () => {
    const stages = deriveCallStages(['no_answer', 'failed']);
    for (const s of stages) {
      expect(s.key).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });
});

describe('deriveCallResponse (#363 Vonage発信失敗の段階表示)', () => {
  it("最終手が failed のときは state='calling' で stages を伴う（KioskCallView を経由して段階表示させる）", () => {
    const res = deriveCallResponse(scenario({ simulatedResults: { call: ['failed'] } }));
    expect(res.state).toBe('calling');
    expect(res.stages.length).toBeGreaterThan(0);
  });

  it('answered は従来どおり state=connected を直接返す（非退行・実SDK接続を誘発しない）', () => {
    const res = deriveCallResponse(scenario({ simulatedResults: { call: ['answered'] } }));
    expect(res.state).toBe('connected');
  });

  it('no_answer は従来どおり state=timeout を直接返す', () => {
    const res = deriveCallResponse(scenario({ simulatedResults: { call: ['no_answer'] } }));
    expect(res.state).toBe('timeout');
  });

  it('declined は従来どおり state=failed を直接返す（技術的失敗ではないため段階表示しない）', () => {
    const res = deriveCallResponse(scenario({ simulatedResults: { call: ['declined'] } }));
    expect(res.state).toBe('failed');
  });

  it('call 未指定は従来どおり no_answer 相当（state=timeout）', () => {
    const res = deriveCallResponse(scenario());
    expect(res.state).toBe('timeout');
  });
});

/** 決定論的な手動スケジューラ（vi のフェイクタイマーに依存せず、段ごとに手で進める）。 */
function manualScheduler() {
  const tasks: Array<{ ms: number; fn: () => void; handle: DemoTimerHandle; cancelled: boolean }> = [];
  let seq = 0;
  const scheduler: DemoScheduler = {
    set: (fn, ms) => {
      const handle = ++seq as unknown as DemoTimerHandle;
      tasks.push({ ms, fn, handle, cancelled: false });
      return handle;
    },
    clear: (handle) => {
      const t = tasks.find((x) => x.handle === handle);
      if (t) t.cancelled = true;
    },
  };
  const ordered = () => [...tasks].sort((a, b) => a.ms - b.ms);
  const runAll = () => ordered().forEach((t) => { if (!t.cancelled) t.fn(); });
  return { scheduler, ordered, runAll };
}

describe('wantsSyntheticVoice (#363/#364 音声成功系の判定)', () => {
  it("stt: 'success' は音声成功系", () => {
    expect(wantsSyntheticVoice(scenario({ simulatedResults: { stt: 'success' } }))).toBe(true);
  });
  it('voice 入力があれば音声成功系', () => {
    expect(wantsSyntheticVoice(scenario({ visitorInputs: [{ mode: 'voice', value: '鈴木' }] }))).toBe(true);
  });
  it("stt: 'error' / 'low_confidence' は失敗系（synthetic を作らない・非退行）", () => {
    expect(wantsSyntheticVoice(scenario({ visitorInputs: [{ mode: 'voice', value: 'x' }], simulatedResults: { stt: 'error' } }))).toBe(false);
    expect(wantsSyntheticVoice(scenario({ simulatedResults: { stt: 'low_confidence' } }))).toBe(false);
  });
  it('voice も stt success も無ければ非対象', () => {
    expect(wantsSyntheticVoice(scenario({ simulatedResults: { call: ['answered'] } }))).toBe(false);
  });
});

describe('deriveVoiceSession (#363/#364 音声シナリオの自動再生)', () => {
  const voiceScenario = () =>
    scenario({ visitorInputs: [{ mode: 'voice', value: '鈴木' }], simulatedResults: { stt: 'success' } });

  it('音声成功系は factory を返し、非対象は undefined', () => {
    expect(deriveVoiceSession(voiceScenario())).toBeTypeOf('function');
    expect(deriveVoiceSession(scenario({ simulatedResults: { call: ['answered'] } }))).toBeUndefined();
    expect(
      deriveVoiceSession(scenario({ visitorInputs: [{ mode: 'voice', value: '鈴木' }], simulatedResults: { stt: 'error' } })),
    ).toBeUndefined();
  });

  it('自動再生: start で listening→readback→confirm と進み、onResolved が合成ディレクトリの相手を渡す', () => {
    const { scheduler, ordered } = manualScheduler();
    const onResolved = vi.fn();
    const factory = deriveVoiceSession(voiceScenario(), { scheduler, stepDelayMs: 10 })!;
    const store = new VoiceKioskStore(factory, { onResolved });
    store.start();

    const steps = ordered();
    expect(steps).toHaveLength(3);

    steps[0]!.fn(); // beginListening
    expect(store.getState().mode).toBe('listening');

    steps[1]!.fn(); // hearTurn（低信頼）→ 復唱確認
    expect(store.getState().mode).toBe('readback');
    expect(store.getState().readbackName).toContain('鈴木');

    steps[2]!.fn(); // confirmYes → 確定 → onResolved
    expect(onResolved).toHaveBeenCalledTimes(1);
    // KioskFlow と同じ写像で、mock-adapter の directory id（staff-suzuki）と噛み合う相手になる。
    const target = voiceCandidateToTarget(onResolved.mock.calls[0]![0]);
    expect(target).toEqual({ type: 'staff', id: 'staff-suzuki', label: 'デモ 鈴木' });
    expect(store.getState().mode).toBe('idle');
  });

  it('close（アンマウント）は保留タイマーを解除し、以後は発火しない（sandbox 越え・遅発を防ぐ）', () => {
    const { scheduler, runAll } = manualScheduler();
    const onResolved = vi.fn();
    const factory = deriveVoiceSession(voiceScenario(), { scheduler, stepDelayMs: 10 })!;
    const store = new VoiceKioskStore(factory, { onResolved });
    store.start();
    store.close(); // アンマウント相当
    runAll(); // 解除済みタイマーは走らない
    expect(onResolved).not.toHaveBeenCalled();
    expect(store.getState().mode).toBe('inactive');
  });

  it('voice 入力が無い stt success では既定発話に解決する（発話文が無くても再生できる）', () => {
    const { scheduler, ordered } = manualScheduler();
    const onResolved = vi.fn();
    const factory = deriveVoiceSession(
      scenario({ visitorInputs: [], simulatedResults: { stt: 'success' } }),
      { scheduler, stepDelayMs: 10 },
    )!;
    const store = new VoiceKioskStore(factory, { onResolved });
    store.start();
    ordered().forEach((t) => t.fn());
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(voiceCandidateToTarget(onResolved.mock.calls[0]![0])).toEqual(
      expect.objectContaining({ type: 'staff', id: 'staff-suzuki' }),
    );
  });
});
