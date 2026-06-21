import { describe, expect, it } from 'vitest';
import {
  buildFallbackTurn,
  buildGreetingMessage,
  buildTurnResult,
  clearOnComplete,
  DEFAULT_FAQ,
  runChatTurn,
  STAFF_QUICK_REPLY,
  suggestionToQuickReply,
  type QuickReply,
} from './chat-logic';
import { MockChatLlmAdapter, type ChatAdapterResponse } from './llm-adapter';
import { isChatActionAllowed, type ReceptionState } from '@/domain/reception/ui-contract';

describe('suggestionToQuickReply', () => {
  it('許可済みアクションは action として採用される', () => {
    // selectingPurpose では selectPurpose が許可される。
    const qr = suggestionToQuickReply('selectingPurpose', {
      label: '面接',
      action: 'selectPurpose',
      optionId: 'interview',
    });
    expect(qr).toEqual({
      kind: 'action',
      label: '面接',
      action: 'selectPurpose',
      optionId: 'interview',
    });
  });

  it('現状態で不許可なアクションは候補から捨てる（null）', () => {
    // idle では selectPurpose は遷移できない。
    const qr = suggestionToQuickReply('idle', { label: '面接', action: 'selectPurpose' });
    expect(qr).toBeNull();
  });

  it('confirm（呼び出し確定）はチャットから確定不可で confirm-redirect に降格する', () => {
    const qr = suggestionToQuickReply('confirming', { label: '呼び出す', action: 'confirm' });
    expect(qr).toEqual({
      kind: 'confirm-redirect',
      label: '呼び出す',
      action: 'confirm',
      needsTouchConfirm: true,
    });
  });

  it('submitVisitorInfo（個人情報確定）も confirm-redirect に降格する', () => {
    const qr = suggestionToQuickReply('inputVisitorInfo', {
      label: '入力内容を確定',
      action: 'submitVisitorInfo',
    });
    expect(qr).toEqual({
      kind: 'confirm-redirect',
      label: '入力内容を確定',
      action: 'submitVisitorInfo',
      needsTouchConfirm: true,
    });
  });

  it('action を伴わない候補は null（ラベルだけ提案は実行候補にしない）', () => {
    expect(suggestionToQuickReply('selectingPurpose', { label: '別の名前で探す' })).toBeNull();
  });
});

describe('buildTurnResult', () => {
  it('許可アクションのみ採用し、最後尾にスタッフ誘導を必ず添える', () => {
    const response: ChatAdapterResponse = {
      reply: '山田さんをお探しですね。候補が2名います',
      suggestions: [
        { label: '営業部 山田太郎さん', action: 'selectTarget', optionId: 'staff-1' },
        { label: '開発部 山田花子さん', action: 'selectTarget', optionId: 'staff-2' },
        // 現状態では許可されない操作は捨てられる。
        { label: '呼び出し確定', action: 'confirm' },
      ],
    };
    const result = buildTurnResult('selectingTarget', response);
    expect(result.isFallback).toBe(false);
    // 2 件の selectTarget + confirm-redirect(降格) + staff。
    const kinds = result.quickReplies.map((q) => q.kind);
    expect(kinds).toContain('action');
    expect(kinds).toContain('confirm-redirect');
    expect(result.quickReplies.at(-1)).toEqual(STAFF_QUICK_REPLY);
  });

  it('採用候補が 0 でも必ずタッチ可能な候補（スタッフ誘導）が 1 件以上残る', () => {
    const response: ChatAdapterResponse = {
      reply: 'よくわかりませんでした',
      suggestions: [{ label: 'なにか', action: 'selectPurpose' }], // idle では不許可
    };
    const result = buildTurnResult('idle', response);
    expect(result.quickReplies.length).toBeGreaterThanOrEqual(1);
    expect(result.quickReplies).toContainEqual(STAFF_QUICK_REPLY);
  });

  it('response が null なら定型フォールバックへ倒す', () => {
    const result = buildTurnResult('selectingTarget', null);
    expect(result.isFallback).toBe(true);
  });

  it('採用されたすべての action 候補は isChatActionAllowed を満たす（不変条件）', () => {
    const states: ReceptionState[] = ['selectingPurpose', 'selectingTarget', 'inputVisitorInfo'];
    for (const state of states) {
      const response: ChatAdapterResponse = {
        reply: 't',
        suggestions: [
          { label: 'a', action: 'selectPurpose' },
          { label: 'b', action: 'selectTarget' },
          { label: 'c', action: 'submitVisitorInfo' },
          { label: 'd', action: 'confirm' },
          { label: 'e', action: 'cancel' },
          { label: 'f', action: 'back' },
        ],
      };
      const result = buildTurnResult(state, response);
      for (const qr of result.quickReplies) {
        if (qr.kind === 'action') {
          expect(isChatActionAllowed(state, qr.action)).toBe(true);
        }
      }
    }
  });
});

describe('buildFallbackTurn', () => {
  it('FAQ とスタッフ誘導を候補に並べる', () => {
    const result = buildFallbackTurn();
    expect(result.isFallback).toBe(true);
    expect(result.quickReplies.length).toBe(DEFAULT_FAQ.length + 1);
    expect(result.quickReplies.at(-1)).toEqual(STAFF_QUICK_REPLY);
  });
});

describe('runChatTurn', () => {
  it('オフライン時は adapter を呼ばずフォールバックする', async () => {
    let called = false;
    const adapter = new MockChatLlmAdapter({});
    const spy = {
      interpret: async (req: Parameters<typeof adapter.interpret>[0]) => {
        called = true;
        return adapter.interpret(req);
      },
    };
    const result = await runChatTurn(spy, 'selectingTarget', '山田さん', { online: false });
    expect(called).toBe(false);
    expect(result.isFallback).toBe(true);
  });

  it('adapter が例外を投げてもフォールバックへ倒す（受付を止めない）', async () => {
    const adapter = new MockChatLlmAdapter({ failOn: ['エラー'] });
    const result = await runChatTurn(adapter, 'selectingTarget', 'エラー');
    expect(result.isFallback).toBe(true);
    expect(result.quickReplies.length).toBeGreaterThanOrEqual(1);
  });

  it('正常応答は候補提示に変換され、自由文を直接実行しない（必ず候補が残る）', async () => {
    const adapter = new MockChatLlmAdapter({
      scripted: {
        '山田さん': {
          reply: '山田さんをお探しですね。候補が2名います',
          suggestions: [
            { label: '営業部 山田太郎さん', action: 'selectTarget', optionId: 's1' },
            { label: '開発部 山田花子さん', action: 'selectTarget', optionId: 's2' },
          ],
        },
      },
    });
    const result = await runChatTurn(adapter, 'selectingTarget', '山田さん');
    expect(result.isFallback).toBe(false);
    const actions = result.quickReplies.filter(
      (q): q is Extract<QuickReply, { kind: 'action' }> => q.kind === 'action',
    );
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.action === 'selectTarget')).toBe(true);
  });

  it('スクリプトに無い入力は mock の既定応答→候補に変換される', async () => {
    const adapter = new MockChatLlmAdapter({
      fallbackResponse: { reply: 'もう一度お願いします', suggestions: [] },
    });
    const result = await runChatTurn(adapter, 'selectingTarget', 'なにか不明な入力');
    // 既定応答は suggestions 空 → スタッフ誘導が必ず付く。
    expect(result.quickReplies).toContainEqual(STAFF_QUICK_REPLY);
  });
});

describe('プライバシー / 履歴', () => {
  it('clearOnComplete は空配列を返す（履歴を残さない）', () => {
    expect(clearOnComplete()).toEqual([]);
  });

  it('buildGreetingMessage は PII を含まない控えめな呼びかけ', () => {
    const msg = buildGreetingMessage();
    expect(msg.role).toBe('assistant');
    expect(msg.text).toContain('お困りですか');
  });
});
