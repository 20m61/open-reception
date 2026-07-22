import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES, transition, type ReceptionState } from './state';
import { motionKeyForState } from '@/domain/motion/types';
import { avatarGuidanceFor } from '@/components/kiosk/avatar/guidance';
import {
  AVATAR_EMOTIONS,
  AVATAR_PRESENCES,
  AVATAR_STATES,
  availableActions,
  buildUiContract,
  CHAT_FORBIDDEN_ACTIONS,
  conversationTurnFor,
  deriveAvatarEmotion,
  deriveAvatarPresence,
  deriveAvatarState,
  deriveCallStatus,
  deriveChatAvailability,
  derivePrivacyState,
  escapeHatchActionsFor,
  gazeTargetFor,
  inputModesFor,
  INPUT_MODES,
  isActionAllowed,
  isChatActionAllowed,
  MESSAGE_KEYS,
  messageKeyForState,
  passesConfirmationInvariant,
  RECEPTION_ACTIONS,
  requiresExplicitConfirmationFor,
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

// =============================================================================
// #361 Character-led: ConversationTurnView 契約
// -----------------------------------------------------------------------------
// 各 ReceptionState を「同じアバターとの 1 会話ターン」として提示するための写像。
// 表示契約の真実源は本モジュール（ui-contract.ts）に一本化する（#361 AC）。
// =============================================================================

describe('reception ui-contract: avatarPresence 導出 (#361)', () => {
  it('全 screenState に有効な presence を返す（網羅）', () => {
    for (const state of RECEPTION_STATES) {
      expect(AVATAR_PRESENCES).toContain(deriveAvatarPresence(state));
    }
  });

  it('待機はアバターが主役(primary)、通話中は静かな最小(minimal)', () => {
    expect(deriveAvatarPresence('idle')).toBe('primary');
    // 通話中はキャラクターが発話を止め静かな待機姿勢へ移る（issue #361 レイアウト方針）。
    expect(deriveAvatarPresence('connected')).toBe('minimal');
  });

  it('選択/入力/確認/呼び出しでもアバターは会話コンパニオンとして継続する（#123 の意図反転）', () => {
    // #123 は「選択/入力画面はコンテンツが密集するためアバターを出さない」としていた。
    // #361 はこれを反転し、同じアバターとの対話が途中で切れないよう companion として継続させる。
    for (const state of [
      'selectingPurpose',
      'selectingTarget',
      'inputVisitorInfo',
      'confirming',
      'calling',
    ] as const) {
      expect(deriveAvatarPresence(state)).toBe('companion');
    }
    // primary/minimal は idle/connected のみ（選択/入力が「非表示(primary扱い)」に戻っていない）。
    expect(deriveAvatarPresence('selectingPurpose')).not.toBe('primary');
    expect(deriveAvatarPresence('inputVisitorInfo')).not.toBe('primary');
  });

  it('結果系(失敗/未応答/代替/完了/中止)もアバターが付き添う(companion)', () => {
    for (const state of ['failed', 'timeout', 'fallback', 'completed', 'cancelled'] as const) {
      expect(deriveAvatarPresence(state)).toBe('companion');
    }
  });
});

describe('reception ui-contract: avatarEmotion 導出 (#361)', () => {
  it('全 screenState に有効な emotion を返す（網羅）', () => {
    for (const state of RECEPTION_STATES) {
      expect(AVATAR_EMOTIONS).toContain(deriveAvatarEmotion(state));
    }
  });

  it('avatar/guidance.ts の expression と一致する（表情語彙の真実源が二重化していない）', () => {
    // guidance.ts は avatarState→表情を持つが、その値は本契約の emotion と一致しなければならない。
    for (const state of RECEPTION_STATES) {
      const emotion = deriveAvatarEmotion(state);
      const guidance = avatarGuidanceFor(deriveAvatarState(state));
      expect(emotion).toBe(guidance.expression);
    }
  });

  it('代表的な対応（確認=思案 / 失敗=気遣い / 完了=笑顔）', () => {
    expect(deriveAvatarEmotion('confirming')).toBe('thinking');
    expect(deriveAvatarEmotion('failed')).toBe('concerned');
    expect(deriveAvatarEmotion('timeout')).toBe('concerned');
    expect(deriveAvatarEmotion('completed')).toBe('happy');
  });
});

describe('reception ui-contract: messageKey / gazeTarget / inputModes (#361)', () => {
  it('全 screenState に一意な messageKey を割り当てる（重複なし・語彙内）', () => {
    const keys = RECEPTION_STATES.map(messageKeyForState);
    for (const k of keys) expect(MESSAGE_KEYS).toContain(k);
    expect(new Set(keys).size).toBe(RECEPTION_STATES.length);
  });

  it('inputModes は必ず touch を含む（タッチだけで完走できる不変条件）', () => {
    for (const state of RECEPTION_STATES) {
      const modes = inputModesFor(state);
      expect(modes).toContain('touch');
      for (const m of modes) expect(INPUT_MODES).toContain(m);
    }
  });

  it('選択/入力ターンは音声・文字も受け付ける', () => {
    for (const state of ['selectingPurpose', 'selectingTarget', 'inputVisitorInfo'] as const) {
      const modes = inputModesFor(state);
      expect(modes).toContain('voice');
      expect(modes).toContain('text');
    }
  });

  it('QR は待機ターンの入口手段として提示する（読み取りだけで発信しない導線）', () => {
    expect(inputModesFor('idle')).toContain('qr');
    // 確認・呼び出しは QR で直接進めない（発信はタッチ確認のみ）。
    expect(inputModesFor('confirming')).not.toContain('qr');
    expect(inputModesFor('calling')).not.toContain('qr');
  });

  it('gazeTarget は次に触れる場所へ視線を向ける（確認→確認CTA / 失敗→代替CTA）', () => {
    expect(gazeTargetFor('inputVisitorInfo')).toBe('form');
    expect(gazeTargetFor('confirming')).toBe('confirmCta');
    expect(gazeTargetFor('failed')).toBe('fallbackCta');
    expect(gazeTargetFor('selectingPurpose')).toBe('answers');
    // 通話中は操作を急かさない（視線誘導なし）。
    expect(gazeTargetFor('connected')).toBe('none');
  });
});

describe('reception ui-contract: requiresExplicitConfirmation (#361)', () => {
  it('個人情報送信(inputVisitorInfo)と発信確定(confirming)はタッチ確認を必須にする', () => {
    expect(requiresExplicitConfirmationFor('inputVisitorInfo')).toBe(true);
    expect(requiresExplicitConfirmationFor('confirming')).toBe(true);
  });

  it('それ以外の状態では明示確認を要求しない', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'inputVisitorInfo' || state === 'confirming') continue;
      expect(requiresExplicitConfirmationFor(state)).toBe(false);
    }
  });

  it('確認必須の状態は必ず REQUIRES_CONFIRMATION 対象アクションを持つ（不変条件と整合）', () => {
    for (const state of RECEPTION_STATES) {
      if (!requiresExplicitConfirmationFor(state)) continue;
      const allowed = availableActions(state);
      const hasCritical = ['confirm', 'submitVisitorInfo'].some((a) =>
        allowed.has(a as ReceptionAction),
      );
      expect(hasCritical).toBe(true);
    }
  });
});

describe('reception ui-contract: escapeHatchActionsFor (#361)', () => {
  it('待機(idle)では逃げ道を出さない', () => {
    expect(escapeHatchActionsFor('idle')).toEqual([]);
  });

  it('逃げ道は back / reset のみ、かつ availableActions の部分集合', () => {
    for (const state of RECEPTION_STATES) {
      for (const hatch of escapeHatchActionsFor(state)) {
        expect(['back', 'reset']).toContain(hatch.action);
        expect(isActionAllowed(state, hatch.action)).toBe(true);
      }
    }
  });

  it('担当者選択(selectingTarget)では戻る・最初に戻るの両方に到達できる', () => {
    const actions = escapeHatchActionsFor('selectingTarget').map((h) => h.action);
    expect(actions).toContain('back');
    expect(actions).toContain('reset');
  });
});

describe('reception ui-contract: conversationTurnFor (#361)', () => {
  it('全 screenState から構造的に妥当な ConversationTurnView を生成する', () => {
    for (const state of RECEPTION_STATES) {
      const turn = conversationTurnFor(state);
      expect(turn.stateKey).toBe(state);
      // avatar
      expect(AVATAR_PRESENCES).toContain(turn.avatar.presence);
      expect(AVATAR_EMOTIONS).toContain(turn.avatar.emotion);
      expect(turn.avatar.motionKey).toBe(motionKeyForState(state));
      // message: semanticKey と displayText は非空。speech===display（別指定が無い限り）。
      expect(MESSAGE_KEYS).toContain(turn.message.semanticKey);
      expect(turn.message.displayText.length).toBeGreaterThan(0);
      // inputModes / escapeHatches / requiresExplicitConfirmation は各導出と一致。
      expect(turn.inputModes).toEqual(inputModesFor(state));
      expect(turn.escapeHatches).toEqual(escapeHatchActionsFor(state));
      expect(turn.requiresExplicitConfirmation).toBe(requiresExplicitConfirmationFor(state));
    }
  });

  it('answers の intent は必ずその画面で許可されたアクション（自由文で不正操作に飛べない）', () => {
    for (const state of RECEPTION_STATES) {
      const turn = conversationTurnFor(state);
      for (const answer of turn.answers) {
        expect(isActionAllowed(state, answer.intent)).toBe(true);
      }
    }
  });

  it('回答候補は原則 4 件以内（1ターン1質問）', () => {
    for (const state of RECEPTION_STATES) {
      expect(conversationTurnFor(state).answers.length).toBeLessThanOrEqual(4);
    }
  });

  it('用件選択ターンは 4 つの目的を回答候補に並べる（selectPurpose）', () => {
    const turn = conversationTurnFor('selectingPurpose');
    expect(turn.answers.length).toBe(4);
    for (const a of turn.answers) expect(a.intent).toBe('selectPurpose');
  });

  it('確認ターンは発信の明示確認を要求し、回答は confirm のみ', () => {
    const turn = conversationTurnFor('confirming');
    expect(turn.requiresExplicitConfirmation).toBe(true);
    expect(turn.answers.map((a) => a.intent)).toEqual(['confirm']);
  });

  it('通話中(connected)はアバターが発話を止める（speak=false・minimal）', () => {
    const turn = conversationTurnFor('connected');
    expect(turn.message.speak).toBe(false);
    expect(turn.avatar.presence).toBe('minimal');
  });

  it('通話中以外はアバターが発話する（speak=true）', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'connected') continue;
      expect(conversationTurnFor(state).message.speak).toBe(true);
    }
  });

  it('displayText/answers は呼び出し側が locale 解決済みの値を注入できる（domain は component に依存しない）', () => {
    const turn = conversationTurnFor('confirming', {
      message: { displayText: 'Please confirm to call.', speechText: 'Please confirm.' },
      answers: [{ id: 'confirm', label: 'Call now', intent: 'confirm' }],
    });
    expect(turn.message.displayText).toBe('Please confirm to call.');
    expect(turn.message.speechText).toBe('Please confirm.');
    expect(turn.answers).toEqual([{ id: 'confirm', label: 'Call now', intent: 'confirm' }]);
  });

  it('注入 answers も intent 検証されずそのまま採用される（呼び出し側の責務）が、既定は許可済みのみ', () => {
    // 既定（注入なし）の answers は必ず許可済みアクション（前段のテストで担保）。ここでは注入経路の疎通のみ。
    const turn = conversationTurnFor('selectingTarget', {
      answers: [{ id: 's1', label: '山田', intent: 'selectTarget' }],
    });
    expect(turn.answers[0]?.intent).toBe('selectTarget');
    expect(isActionAllowed('selectingTarget', 'selectTarget')).toBe(true);
  });
});
