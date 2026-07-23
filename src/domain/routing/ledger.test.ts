import { describe, expect, it } from 'vitest';
import { emptyLedger, idempotencyKey, recordProviderEvent } from './ledger';

describe('idempotencyKey (#374)', () => {
  it('callUuid と providerEventId の組で一意化する', () => {
    expect(idempotencyKey('call-1', 'evt-1')).toBe('call-1#evt-1');
    // 別 call の同 event id は別キー。
    expect(idempotencyKey('call-2', 'evt-1')).not.toBe(idempotencyKey('call-1', 'evt-1'));
  });
});

describe('recordProviderEvent (#374)', () => {
  it('初回イベントは duplicate:false で台帳へ加わる', () => {
    const r = recordProviderEvent(emptyLedger(), 'call-1', 'evt-1');
    expect(r.duplicate).toBe(false);
    expect(r.ledger.has('call-1#evt-1')).toBe(true);
  });

  it('同一 (callUuid, providerEventId) の再配信は duplicate:true で台帳を変えない', () => {
    const first = recordProviderEvent(emptyLedger(), 'call-1', 'evt-1');
    const second = recordProviderEvent(first.ledger, 'call-1', 'evt-1');
    expect(second.duplicate).toBe(true);
    expect(second.ledger).toBe(first.ledger); // 同一参照＝変更なし
  });

  it('別 call の同 event id は重複扱いしない（境界は call 単位）', () => {
    const first = recordProviderEvent(emptyLedger(), 'call-1', 'evt-1');
    const second = recordProviderEvent(first.ledger, 'call-2', 'evt-1');
    expect(second.duplicate).toBe(false);
    expect(second.ledger.has('call-2#evt-1')).toBe(true);
  });

  it('元の台帳をミューテートしない（イミュータブル）', () => {
    const base = emptyLedger();
    recordProviderEvent(base, 'call-1', 'evt-1');
    expect(base.size).toBe(0);
  });
});
