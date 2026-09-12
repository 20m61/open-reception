import { describe, expect, it, vi } from 'vitest';
import type { Staff } from '@/domain/staff/types';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import type { VoiceSessionCallbacks } from './orchestrator';
import {
  createOrchestratorVoiceSession,
  createSyntheticVoiceSession,
} from './kiosk-binding';

const staff: Staff = {
  id: 'suzuki',
  displayName: '鈴木 一郎',
  kana: 'すずきいちろう',
  aliases: ['鈴木さん'],
  departmentId: 'sales',
  enabled: true,
  available: true,
  callTargets: [],
  fallbackStaffIds: [],
};

const directory: EntityDirectory = { staff: [staff], departments: [] };

function collector() {
  const events: VoiceKioskEvent[] = [];
  return { events, emit: (event: VoiceKioskEvent) => events.push(event) };
}

describe('committed utterance claim hook (#1077)', () => {
  it('synthetic: Kioskがclaimした発話はtarget-only onResolvedを二重実行しない', () => {
    const { emit, events } = collector();
    const onResolved = vi.fn();
    const onCommittedUtterance = vi.fn(() => true);
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.93 });

    driver.factory(emit, { onResolved, onCommittedUtterance }).start();
    driver.beginListening();
    driver.hearTurn('鈴木さんに打ち合わせで来ました。張です');

    expect(onCommittedUtterance).toHaveBeenCalledWith({
      text: '鈴木さんに打ち合わせで来ました。張です',
      sttConfidence: 0.93,
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'heardAccepted' });
  });

  it('synthetic: claimしない場合は既存target解決をそのまま維持する', () => {
    const { emit } = collector();
    const onResolved = vi.fn();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95 });

    driver.factory(emit, {
      onResolved,
      onCommittedUtterance: () => false,
    }).start();
    driver.hearTurn('鈴木 一郎');

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0]?.[0]).toMatchObject({ id: 'suzuki', kind: 'staff' });
  });

  it('orchestrator wrapperでもclaim時はlegacy resolverへ流さない', () => {
    const { emit, events } = collector();
    const onResolved = vi.fn();
    let callbacks: VoiceSessionCallbacks | undefined;
    const factory = createOrchestratorVoiceSession(
      (nextCallbacks) => {
        callbacks = nextCallbacks;
        return { start: () => {}, close: () => {}, resetTurn: () => {} };
      },
      { directory, sttConfidence: 0.91 },
    );

    factory(emit, {
      onResolved,
      onCommittedUtterance: () => true,
    });
    callbacks?.onTurnCommitted?.('鈴木さんに面会です。張です', 'silence');

    expect(onResolved).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'heardAccepted' });
  });
});
