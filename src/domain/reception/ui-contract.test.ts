import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES, transition, type ReceptionState } from './state';
import {
  AVATAR_STATES,
  availableActions,
  buildUiContract,
  CHAT_FORBIDDEN_ACTIONS,
  deriveAvatarState,
  deriveCallStatus,
  deriveChatAvailability,
  derivePrivacyState,
  isActionAllowed,
  isChatActionAllowed,
  passesConfirmationInvariant,
  RECEPTION_ACTIONS,
  type ReceptionAction,
} from './ui-contract';

describe('reception ui-contract: availableActions / isActionAllowed', () => {
  it('availableActions は state.ts の transition と整合する（二重定義していない）', () => {
    // 各 state について、availableActions に含まれる ⟺ そのアクションが有効遷移を持つ。
    const actionToEvent = {
      start: 'START',
      selectPurpose: 'SELECT_PURPOSE',
      selectTarget: 'SELECT_TARGET',
      submitVisitorInfo: 'SUBMIT_VISITOR_INFO',
      confirm: 'CONFIRM',
      cancel: 'CANCEL',
      back: 'BACK',
      useFallback: 'USE_FALLBACK',
      complete: 'COMPLETE',
      reset: 'RESET',
    } as const;

    for (const state of RECEPTION_STATES) {
      const allowed = availableActions(state);
      for (const action of RECEPTION_ACTIONS) {
        const viaTransition = transition(state, actionToEvent[action]) !== null;
        expect(allowed.has(action)).toBe(viaTransition);
      }
    }
  });

  it('idle では start と reset のみ許可（自由文で確定操作に飛べない）', () => {
    const allowed = availableActions('idle');
    expect(allowed.has('start')).toBe(true);
    expect(allowed.has('reset')).toBe(true);
    expect(allowed.has('confirm')).toBe(false);
    expect(allowed.has('submitVisitorInfo')).toBe(false);
  });

  it('confirming でのみ confirm が許可される', () => {
    expect(isActionAllowed('confirming', 'confirm')).toBe(true);
    for (const state of RECEPTION_STATES) {
      if (state === 'confirming') continue;
      expect(isActionAllowed(state, 'confirm')).toBe(false);
    }
  });

  it('reset はどの状態でも許可される（端末の自動リセット）', () => {
    for (const state of RECEPTION_STATES) {
      expect(isActionAllowed(state, 'reset')).toBe(true);
    }
  });
});

describe('reception ui-contract: チャット/LLM のアクション制限', () => {
  it('重要操作（confirm / submitVisitorInfo）はチャットから直接実行できない', () => {
    expect(CHAT_FORBIDDEN_ACTIONS.has('confirm')).toBe(true);
    expect(CHAT_FORBIDDEN_ACTIONS.has('submitVisitorInfo')).toBe(true);

    // 本来許可される state でもチャット経由は弾く。
    expect(isActionAllowed('confirming', 'confirm')).toBe(true);
    expect(isChatActionAllowed('confirming', 'confirm')).toBe(false);

    expect(isActionAllowed('inputVisitorInfo', 'submitVisitorInfo')).toBe(true);
    expect(isChatActionAllowed('inputVisitorInfo', 'submitVisitorInfo')).toBe(false);
  });

  it('チャットは許可済みの非重要操作（cancel/back 等）は実行できる', () => {
    expect(isChatActionAllowed('selectingTarget', 'back')).toBe(true);
    expect(isChatActionAllowed('selectingPurpose', 'cancel')).toBe(true);
  });

  it('チャットでも screenState で許可されない操作は実行できない', () => {
    expect(isChatActionAllowed('idle', 'cancel')).toBe(false);
  });

  it('チャットから実行可能なアクションは必ず availableActions の部分集合', () => {
    for (const state of RECEPTION_STATES) {
      const allowed = availableActions(state);
      for (const action of RECEPTION_ACTIONS) {
        if (isChatActionAllowed(state, action)) {
          expect(allowed.has(action)).toBe(true);
        }
      }
    }
  });
});

describe('reception ui-contract: 確認必須の不変条件', () => {
  it('confirm は confirming からのみ不変条件を満たす', () => {
    expect(passesConfirmationInvariant('confirming', 'confirm')).toBe(true);
    for (const state of RECEPTION_STATES) {
      if (state === 'confirming') continue;
      expect(passesConfirmationInvariant(state, 'confirm')).toBe(false);
    }
  });

  it('submitVisitorInfo は inputVisitorInfo からのみ、かつ確定先が confirming', () => {
    expect(passesConfirmationInvariant('inputVisitorInfo', 'submitVisitorInfo')).toBe(true);
    expect(transition('inputVisitorInfo', 'SUBMIT_VISITOR_INFO')).toBe('confirming');
    for (const state of RECEPTION_STATES) {
      if (state === 'inputVisitorInfo') continue;
      expect(passesConfirmationInvariant(state, 'submitVisitorInfo')).toBe(false);
    }
  });

  it('重要操作以外は不変条件を常に満たす（制約対象外）', () => {
    const nonCritical = RECEPTION_ACTIONS.filter(
      (a) => a !== 'confirm' && a !== 'submitVisitorInfo',
    );
    for (const action of nonCritical) {
      for (const state of RECEPTION_STATES) {
        expect(passesConfirmationInvariant(state, action)).toBe(true);
      }
    }
  });

  it('呼び出し確定は必ず confirming 経由（calling へは confirm でしか入れない）', () => {
    // 呼び出し中(calling)へ入る唯一の遷移が confirming -CONFIRM-> calling であることを確認。
    const enteringCalling: ReceptionState[] = [];
    for (const state of RECEPTION_STATES) {
      if (isActionAllowed(state, 'confirm') && transition(state, 'CONFIRM') === 'calling') {
        enteringCalling.push(state);
      }
    }
    expect(enteringCalling).toEqual(['confirming']);
  });
});

describe('reception ui-contract: avatarState 導出', () => {
  it('全 screenState に対し有効な avatarState を返す（網羅）', () => {
    for (const state of RECEPTION_STATES) {
      const avatar = deriveAvatarState(state);
      expect(AVATAR_STATES).toContain(avatar);
    }
  });

  it('代表的な対応関係', () => {
    expect(deriveAvatarState('idle')).toBe('idle');
    expect(deriveAvatarState('selectingPurpose')).toBe('greeting');
    expect(deriveAvatarState('inputVisitorInfo')).toBe('listening');
    expect(deriveAvatarState('confirming')).toBe('confirming');
    expect(deriveAvatarState('calling')).toBe('calling');
    expect(deriveAvatarState('failed')).toBe('apologizing');
    expect(deriveAvatarState('timeout')).toBe('apologizing');
    expect(deriveAvatarState('completed')).toBe('farewell');
  });
});

describe('reception ui-contract: callStatus / privacyState / chatAvailability 導出', () => {
  it('callStatus は局面を反映する', () => {
    expect(deriveCallStatus('idle')).toBe('none');
    expect(deriveCallStatus('confirming')).toBe('none');
    expect(deriveCallStatus('calling')).toBe('dialing');
    expect(deriveCallStatus('connected')).toBe('connected');
    expect(deriveCallStatus('completed')).toBe('ended');
    expect(deriveCallStatus('failed')).toBe('failed');
    expect(deriveCallStatus('timeout')).toBe('failed');
  });

  it('privacyState は PII 入力中/保持中を区別する', () => {
    expect(derivePrivacyState('selectingPurpose')).toBe('none');
    expect(derivePrivacyState('inputVisitorInfo')).toBe('collecting');
    expect(derivePrivacyState('confirming')).toBe('retained');
    expect(derivePrivacyState('calling')).toBe('retained');
    // 終端でクリアされる局面は none。
    expect(derivePrivacyState('cancelled')).toBe('none');
    expect(derivePrivacyState('completed')).toBe('none');
  });

  it('chatAvailability は待機/終端で閉じ、進行中で開ける', () => {
    expect(deriveChatAvailability('idle')).toBe('unavailable');
    expect(deriveChatAvailability('cancelled')).toBe('unavailable');
    expect(deriveChatAvailability('completed')).toBe('unavailable');
    expect(deriveChatAvailability('selectingPurpose')).toBe('available');
    expect(deriveChatAvailability('inputVisitorInfo')).toBe('available');
  });
});

describe('reception ui-contract: buildUiContract', () => {
  it('screenState から導出値が一貫した契約を組み立てる', () => {
    const contract = buildUiContract('confirming');
    expect(contract.screenState).toBe('confirming');
    expect(contract.avatarState).toBe('confirming');
    expect(contract.callStatus).toBe('none');
    expect(contract.privacyState).toBe('retained');
    expect(contract.chatAvailability).toBe('available');
    expect(contract.availableActions.has('confirm')).toBe(true);
    expect(contract.chatMessages).toEqual([]);
    expect(contract.visitorInput).toEqual({ isEditing: false });
  });

  it('UI 補助状態（chatMessages / visitorInput）を受け取れる', () => {
    const contract = buildUiContract('inputVisitorInfo', {
      chatMessages: [
        { id: '1', role: 'assistant', text: 'お困りですか？', createdAt: '2026-06-21T00:00:00Z' },
      ],
      visitorInput: { isEditing: true, activeField: 'name' },
    });
    expect(contract.chatMessages).toHaveLength(1);
    expect(contract.visitorInput.isEditing).toBe(true);
    expect(contract.visitorInput.activeField).toBe('name');
  });

  it('導出値は個別関数の結果と一致する（再計算ズレがない）', () => {
    for (const state of RECEPTION_STATES) {
      const contract = buildUiContract(state);
      expect(contract.avatarState).toBe(deriveAvatarState(state));
      expect(contract.callStatus).toBe(deriveCallStatus(state));
      expect(contract.privacyState).toBe(derivePrivacyState(state));
      expect(contract.chatAvailability).toBe(deriveChatAvailability(state));
      expect([...contract.availableActions].sort()).toEqual([...availableActions(state)].sort());
    }
  });
});
