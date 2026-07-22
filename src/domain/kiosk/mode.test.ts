import { describe, expect, it } from 'vitest';
import { resolveKioskMode, KIOSK_MODES } from './mode';
import type { ReceptionState } from '@/domain/reception/state';

const ready = 'ready' as const;

describe('resolveKioskMode (#362)', () => {
  it('gate が ready でなければ常に degraded（技術的な利用不可を最優先）', () => {
    for (const gate of ['revoked', 'authorize', 'unenrolled', 'checking'] as const) {
      expect(
        resolveKioskMode({ gate, uiMode: 'normal', receptionState: 'idle' }),
      ).toBe('degraded');
      // uiMode/receptionState に関わらず degraded が勝つ
      expect(
        resolveKioskMode({ gate, uiMode: 'checkin', receptionState: 'calling' }),
      ).toBe('degraded');
    }
  });

  it('QR 受付モードは qr_reception（idle 以外の receptionState でも優先）', () => {
    expect(
      resolveKioskMode({ gate: ready, uiMode: 'checkin', receptionState: 'idle' }),
    ).toBe('qr_reception');
  });

  it('receptionState=idle かつ通常モードは signage（サイネージ/待機画面）', () => {
    expect(
      resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState: 'idle' }),
    ).toBe('signage');
  });

  it('受付業務の進行ステップは reception', () => {
    const inProgress: ReceptionState[] = [
      'selectingPurpose',
      'selectingTarget',
      'inputVisitorInfo',
      'confirming',
      'calling',
      'connected',
    ];
    for (const receptionState of inProgress) {
      expect(
        resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState }),
      ).toBe('reception');
    }
  });

  it('終端/結果表示ステップは completion', () => {
    const terminal: ReceptionState[] = ['completed', 'cancelled', 'failed', 'timeout', 'fallback'];
    for (const receptionState of terminal) {
      expect(
        resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState }),
      ).toBe('completion');
    }
  });

  it('営業時間外(operatingStatus=closed)かつ待機(idle)は out_of_hours（#367 の表示受け口）', () => {
    expect(
      resolveKioskMode({
        gate: ready,
        uiMode: 'normal',
        receptionState: 'idle',
        operatingStatus: 'closed',
      }),
    ).toBe('out_of_hours');
  });

  it('営業時間外でも受付進行中は中断しない（in-progress は reception を維持＝閉店で来訪者を放り出さない）', () => {
    for (const receptionState of ['selectingPurpose', 'calling', 'connected'] as const) {
      expect(
        resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState, operatingStatus: 'closed' }),
      ).toBe('reception');
    }
  });

  it('営業時間外でも QR 受付/技術的利用不可は優先される（degraded > qr_reception > out_of_hours）', () => {
    expect(
      resolveKioskMode({ gate: 'revoked', uiMode: 'normal', receptionState: 'idle', operatingStatus: 'closed' }),
    ).toBe('degraded');
    expect(
      resolveKioskMode({ gate: ready, uiMode: 'checkin', receptionState: 'idle', operatingStatus: 'closed' }),
    ).toBe('qr_reception');
  });

  it('fail-open: operatingStatus 未指定/open のときは従来どおり signage（判定不能は通常受付）', () => {
    expect(resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState: 'idle' })).toBe('signage');
    expect(
      resolveKioskMode({ gate: ready, uiMode: 'normal', receptionState: 'idle', operatingStatus: 'open' }),
    ).toBe('signage');
  });

  it('KIOSK_MODES は issue #362 の型定義どおり 6 種（out_of_hours は営業時間外連携向け）', () => {
    expect(KIOSK_MODES).toEqual([
      'signage',
      'reception',
      'qr_reception',
      'completion',
      'out_of_hours',
      'degraded',
    ]);
  });
});
