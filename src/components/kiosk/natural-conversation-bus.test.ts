import { describe, expect, it, vi } from 'vitest';
import {
  committedUtteranceSubscriberCount,
  publishCommittedUtterance,
  subscribeCommittedUtterance,
} from './natural-conversation-bus';

describe('natural conversation committed utterance bus (#1077)', () => {
  it('listenerが無ければclaimせずlegacy音声経路を残す', () => {
    expect(committedUtteranceSubscriberCount()).toBe(0);
    expect(publishCommittedUtterance({ text: '鈴木さん', sttConfidence: 0.9 })).toBe(false);
  });

  it('同期listenerへだけ渡し、unsubscribe後は発話を再保持しない', () => {
    const listener = vi.fn(() => true);
    const unsubscribe = subscribeCommittedUtterance(listener);

    expect(committedUtteranceSubscriberCount()).toBe(1);
    expect(
      publishCommittedUtterance({
        text: '鈴木さんに打ち合わせで来ました。張です',
        sttConfidence: 0.95,
      }),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(committedUtteranceSubscriberCount()).toBe(0);
    expect(publishCommittedUtterance({ text: '別の発話', sttConfidence: 0.8 })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
