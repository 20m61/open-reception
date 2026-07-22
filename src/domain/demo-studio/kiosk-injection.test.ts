import { describe, expect, it } from 'vitest';
import {
  deriveCallResponse,
  deriveCallStages,
  deriveKioskFlowProps,
  deriveOperatingStatus,
  deriveQrScanner,
  deriveSttAdapterFactory,
} from './kiosk-injection';
import { InjectableQrScanner } from '@/components/kiosk/qr-injection';
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
