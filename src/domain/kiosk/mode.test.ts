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

  it('KIOSK_MODES は issue #362 の型定義どおり 6 種（out_of_hours は将来の営業時間外連携向けに予約）', () => {
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
