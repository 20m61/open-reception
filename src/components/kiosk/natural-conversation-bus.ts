'use client';

import type { CommittedVoiceUtterance } from '@/lib/voice-session/kiosk-binding';

/**
 * #1077: VoiceSessionLayer と Reception screen coordinator を疎結合にする同期bus。
 *
 * 重要:
 * - transcript は保存しない。履歴・キュー・再送を持たない。
 * - publish中の同期listenerにだけ渡し、関数終了後はbusが参照を保持しない。
 * - listenerが1つでもclaimしたらtrue。claimされなければ旧target-only音声経路がそのまま動く。
 *
 * KioskFlow本体へ巨大な配線変更を入れず、既存の voiceSession seam と screen renderer の間を
 * 接続するための一時的なUI層イベント。ドメイン状態の真実源ではない。
 */
export type CommittedUtteranceListener = (utterance: CommittedVoiceUtterance) => boolean;

const listeners = new Set<CommittedUtteranceListener>();

export function subscribeCommittedUtterance(listener: CommittedUtteranceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishCommittedUtterance(utterance: CommittedVoiceUtterance): boolean {
  let claimed = false;
  // listenerが購読解除してもiterationを壊さないようsnapshotで回す。
  for (const listener of [...listeners]) {
    if (listener(utterance)) claimed = true;
  }
  return claimed;
}

/** テスト用。PIIを保持していないことを件数だけで確認する。 */
export function committedUtteranceSubscriberCount(): number {
  return listeners.size;
}
