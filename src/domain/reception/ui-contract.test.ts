import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES, transition, type ReceptionState } from './state';
import {
  CHECKIN_STATES,
  CHECKIN_ERROR_STATES,
  CHECKIN_TERMINAL_STATES,
  transition as checkinTransition,
} from '@/domain/checkin/state';
import { motionKeyForState } from '@/domain/motion/types';
import { CALL_FAILURE_REASONS, shouldOfferAlternativeContact } from './call-failure';
import { avatarGuidanceFor, type AvatarGuidanceCue } from '@/components/kiosk/avatar/guidance';
// 契約の ja フォールバック文言が、画面が実際に出す訳と一致することを突き合わせるために使う
// （本番の ui-contract.ts は i18n に依存しない。テストだけの参照）。
import { DICTIONARIES, type MessageKey as I18nMessageKey } from '@/lib/i18n';

import {
  AVATAR_EMOTIONS,
  AVATAR_PRESENCES,
  AVATAR_STATES,
  availableActions,
  buildUiContract,
  CHAT_FORBIDDEN_ACTIONS,
  CHECKIN_MESSAGE_KEYS,
  checkinAvatarProxyState,
  checkinConversationTurnFor,
  checkinEscapeHatchesFor,
  checkinInputModesFor,
  checkinMessageKeyFor,
  checkinRequiresExplicitConfirmation,
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
  REQUIRES_CONFIRMATION_ACTIONS,
  type GazeTarget,
  INPUT_MODES,
  isActionAllowed,
  isChatActionAllowed,
  MESSAGE_KEYS,
  messageKeyForState,
  passesConfirmationInvariant,
  PERSISTENT_REGIONS,
  regionOfTurnPart,
  RECEPTION_ACTIONS,
  requiresExplicitConfirmationFor,
  type ReceptionAction,
} from './ui-contract';

/**
 * ja 辞書の訳文。キーが消えたら（訳の整理・リネーム）その場で落とす — undefined と
 * 突き合わせて「一致した」ことにしないため。
 */
function ja(key: I18nMessageKey): string {
  const value = DICTIONARIES.ja[key];
  if (value === undefined) throw new Error(`ja 辞書に ${key} が無い`);
  return value;
}

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

  // inputModes は「その局面で実際に受け付けられる入力手段」の宣言であり、努力目標ではない。
  // 実装に無い手段を宣言すると、アクセシビリティ上の主張が事実でなくなる（差分 C'）。
  // 各局面の根拠:
  //   selectingPurpose … PurposeView はボタンのみ（reception-screens.tsx）。音声・文字の経路が無い。
  //   selectingTarget  … 検索欄（文字）と VoiceSessionLayer の onResolved（音声で相手を確定）が有る。
  //   inputVisitorInfo … 氏名フォーム（文字）は有るが、音声で SUBMIT_VISITOR_INFO を生む経路は無い。
  // 音声入力を増やすこと自体は Journey の意味に関わる判断なので、実装が追いついたときに
  // 宣言を足す（宣言を先に置かない）。
  it('宣言する inputModes は実装されている手段だけに限る（差分 C\'）', () => {
    expect(inputModesFor('selectingPurpose')).toEqual(['touch']);
    expect(inputModesFor('selectingTarget')).toEqual(['touch', 'voice', 'text']);
    expect(inputModesFor('inputVisitorInfo')).toEqual(['touch', 'text']);
  });

  it('音声で相手を確定できるのは selectingTarget だけ（唯一の実結線点）', () => {
    const voiceStates = RECEPTION_STATES.filter((s) => inputModesFor(s).includes('voice'));
    expect(voiceStates).toEqual(['selectingTarget']);
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

// =============================================================================
// #422 inc5-b 地ならし: 残る 3 導出（emotion / gaze / requiresExplicitConfirmation）を
// 実挙動へ突き合わせる。
//
// `ConversationTurnView` の 9 導出のうち 6 つが消費者ゼロで、調べた 4 つすべてが実挙動と
// 乖離していた（#481 #486 #487）。テストが無い契約は「在る」だけで「正しい」ではない。
//
// - deriveAvatarEmotion … 実挙動（AvatarGuide が描画する guidance.expression）との
//   クロスチェックが既に在る（上の「avatar/guidance.ts の expression と一致する」）。
//   本 increment での修正は不要。ただし #323 の呼び出し段階オーバーライド
//   （preTimeoutNotice → 'concerned'）は screenState だけでは表現できず、component 層の
//   `guidanceOverride` が担う。契約はあくまで段階以前の基底値を返す。
// - gazeTarget … 下記 2 件の乖離を修正する。
// - requiresExplicitConfirmation … 実挙動と一致していたが、それを縛るテストが無かった。
// =============================================================================

describe('reception ui-contract: gazeTarget を実在する領域へ縛る (#422 inc5-b)', () => {
  it('視線誘導先は、その画面に実在する領域だけを指す', () => {
    // 根拠は reception-screens.tsx の各ビュー。
    // fallback: FallbackView は CTA を一切持たない（#325 で fallback-reset を撤去し、後退は
    // 逃げ道バー escape-reset へ一本化した）。`defaultAnswersFor('fallback')` が [] を返すのと
    // 同じ理由で、視線を向ける先も無い。'answers' を指したまま VRM へ配線すると、アバターが
    // 存在しない選択肢を見つめる。
    expect(gazeTargetFor('fallback')).toBe('none');
    // cancelled / completed: EndView（見出しと本文のみ。満足度評価は任意で急かさない）。
    expect(gazeTargetFor('cancelled')).toBe('none');
    expect(gazeTargetFor('completed')).toBe('none');
    // connected: 終了操作は secondary の任意アクション。「操作は不要」と案内する画面なので
    // 視線でも急かさない（#324-5）。
    expect(gazeTargetFor('connected')).toBe('none');
  });

  it('answers を指す状態は、既定または実行時注入で必ず回答領域を持つ', () => {
    // 回答領域が実行時注入（担当者一覧・クイックアクション）の状態を明示し、それ以外で
    // 'answers' を指すなら既定 answers が非空であることを要求する。fallback のように
    // 「既定も注入も無い」状態が 'answers' を指して紛れ込むのを防ぐ。
    const RUNTIME_INJECTED: ReadonlySet<ReceptionState> = new Set([
      'idle', // IdleView の quickActionsFor('idle')
      'selectingTarget', // 担当者/部署の実行時リスト
    ]);
    for (const state of RECEPTION_STATES) {
      if (gazeTargetFor(state) !== 'answers') continue;
      if (RUNTIME_INJECTED.has(state)) continue;
      expect(conversationTurnFor(state).answers.length, state).toBeGreaterThan(0);
    }
  });

  it('gazeTarget は AvatarGuide が実 DOM へ出す data-cue と矛盾しない', () => {
    // `AvatarGuidanceCue`（guidance.ts）と `GazeTarget`（本契約）は「どこへ誘導するか」を
    // 別語彙で二重に持っている。cue は `data-cue` として実 DOM に出る表示側で、gaze は
    // VRM 視線適用（#65）の真実源。整合を固定しないと #486（逃げ道の二重実装）と同じ形で
    // 静かに乖離する。cue は所作（reassure/inviteTouch）も含む superset なので、視線先へ
    // 写せる値だけを突き合わせる。
    const CUE_TO_GAZE: Partial<Record<AvatarGuidanceCue, GazeTarget>> = {
      lookAtChoices: 'answers',
      lookAtForm: 'form',
      lookAtConfirm: 'confirmCta',
      offerAlternative: 'fallbackCta',
    };
    // cue は avatarState キーなので、'guiding' が selectingTarget（選択肢あり）と
    // fallback（CTA 無し）の両方を覆ってしまい、fallback だけは構造的に正しくできない。
    // screenState キーの契約側が正しく、cue 側が粗い — この既知の非対称だけを許す。
    const COARSE_CUE_STATES: ReadonlySet<ReceptionState> = new Set(['fallback']);
    for (const state of RECEPTION_STATES) {
      const cue = avatarGuidanceFor(deriveAvatarState(state)).cue;
      const mapped = CUE_TO_GAZE[cue];
      if (mapped === undefined) continue; // 所作系の cue は視線先を主張しない
      if (COARSE_CUE_STATES.has(state)) {
        expect(gazeTargetFor(state), state).toBe('none');
        continue;
      }
      expect(gazeTargetFor(state), state).toBe(mapped);
    }
  });
});

describe('reception ui-contract: 通信断の failed は代替導線を約束しない (#422 inc5-b)', () => {
  // ResultView（reception-screens.tsx）は `shouldOfferAlternativeContact(failureReason)` が
  // false のとき use-fallback CTA を**出さない**。代替導線の文言は「代表窓口にお繋ぎします」
  // ＝システムが取り次ぐという約束で、通信が切れている端末はそれを果たせないため。
  // 契約が無条件に代替導線を返していると、配線した時点でその約束が通信断の画面に復活する。
  it('通信断(network)では既定 answers に代替導線を含めない', () => {
    expect(conversationTurnFor('failed', { callFailureReason: 'network' }).answers).toEqual([]);
  });

  it('通信断以外（server / 理由不明）では従来どおり代替導線を出す', () => {
    expect(conversationTurnFor('failed', { callFailureReason: 'server' }).answers).toEqual([
      { id: 'fallback', label: ja('reception.altContact'), intent: 'useFallback' },
    ]);
    expect(conversationTurnFor('failed').answers.map((a) => a.intent)).toEqual(['useFallback']);
  });

  it('未応答(timeout)は理由に依らず代替導線を出す（呼び出しは到達している）', () => {
    for (const reason of [...CALL_FAILURE_REASONS, undefined] as const) {
      const turn = conversationTurnFor('timeout', reason ? { callFailureReason: reason } : undefined);
      expect(turn.answers.map((a) => a.intent), String(reason)).toEqual(['useFallback']);
    }
  });

  it('代替導線を出すかの判断は shouldOfferAlternativeContact に一本化する（二重実装しない）', () => {
    for (const reason of [...CALL_FAILURE_REASONS, undefined] as const) {
      const turn = conversationTurnFor('failed', reason ? { callFailureReason: reason } : undefined);
      expect(turn.answers.length > 0, String(reason)).toBe(shouldOfferAlternativeContact(reason));
    }
  });

  it('通信断では視線も代替 CTA を指さない（存在しない CTA を見つめない）', () => {
    expect(gazeTargetFor('failed', { callFailureReason: 'network' })).toBe('none');
    expect(
      conversationTurnFor('failed', { callFailureReason: 'network' }).avatar.gazeTarget,
    ).toBeUndefined();
    // 出す側は従来どおり代替 CTA を指す。
    expect(gazeTargetFor('failed', { callFailureReason: 'server' })).toBe('fallbackCta');
    expect(gazeTargetFor('failed')).toBe('fallbackCta');
  });
});

describe('reception ui-contract: requiresExplicitConfirmation を実挙動へ縛る (#422 inc5-b)', () => {
  it('確認必須のターンは音声入力を宣言しない（音声だけで発信・PII 確定が起きない）', () => {
    // 音声の実結線点は selectingTarget だけ（VoiceSessionLayer → onResolved → SELECT_TARGET）。
    // 復唱「はい」も担当者確定に閉じており、CONFIRM / SUBMIT_VISITOR_INFO を生む経路は無い。
    for (const state of RECEPTION_STATES) {
      if (!requiresExplicitConfirmationFor(state)) continue;
      expect(inputModesFor(state), state).not.toContain('voice');
    }
  });

  it('確認必須のターンは QR でも進めない（読み取りだけで発信しない）', () => {
    for (const state of RECEPTION_STATES) {
      if (!requiresExplicitConfirmationFor(state)) continue;
      expect(inputModesFor(state), state).not.toContain('qr');
    }
  });

  it('発信確定ターン(confirming)の既定 answers は確定 CTA 1 つだけ（主 CTA が一意）', () => {
    // 画面（ConfirmView）の主 CTA は confirm-call のみ。修正は footer の confirm-back、
    // 後退は逃げ道バーで、確定を起こす回答は 1 つに保つ。
    const answers = conversationTurnFor('confirming').answers;
    expect(answers.map((a) => a.intent)).toEqual(['confirm']);
  });

  it('確認必須のターン以外に確定アクションを持つ回答が現れない', () => {
    // 既定 answers の intent が REQUIRES_CONFIRMATION_ACTIONS に触れるのは、
    // requiresExplicitConfirmation=true のターンだけ。
    for (const state of RECEPTION_STATES) {
      const critical = conversationTurnFor(state).answers.filter((a) =>
        REQUIRES_CONFIRMATION_ACTIONS.has(a.intent),
      );
      if (critical.length > 0) expect(requiresExplicitConfirmationFor(state), state).toBe(true);
    }
  });
});

describe('reception ui-contract: 待機の入口を契約が持つ (#422 inc5-b 増分 3b)', () => {
  // 待機画面の 5 つの入口は `components/kiosk/quick-actions.ts` の QUICK_ACTIONS が持っていた。
  // 「いつ出すか」は既に契約（isActionAllowed(state,'start')）に従っていたが、**集合の定義と
  // 意味（用件の先取り / QR 受付への引き渡し）は component 側にしか無かった**。
  it('待機は用件を先取りする 3 つの入口と、先取りしない 1 つを回答に持つ', () => {
    const answers = conversationTurnFor('idle').answers;
    expect(answers.map((a) => a.id)).toEqual(['callStaff', 'department', 'delivery', 'other']);
    // すべて受付開始。用件の先取りは presetPurpose で表す（別のアクションを作らない）。
    for (const answer of answers) expect(answer.intent, answer.id).toBe('start');
    expect(answers.map((a) => a.presetPurpose)).toEqual([
      undefined, // callStaff: 用件は後段の目的選択で確定する汎用導線
      'meeting', // department
      'delivery',
      'other',
    ]);
  });

  it('待機以外は入口回答を持たない（受付開始は待機からだけ）', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'idle') continue;
      for (const answer of conversationTurnFor(state).answers) {
        expect(answer.presetPurpose, `${state}/${answer.id}`).toBeUndefined();
      }
    }
  });

  it('QR 受付は回答ではなく引き渡し（handoff）として持つ', () => {
    // QR 受付は状態機械を進めない（START ではなく CheckinFlow へのモード切替）。
    // `answers` に混ぜると「回答の intent は必ず許可済みアクション」という安全不変条件に
    // 嘘の intent を通すことになる。会話そのものを別のターン空間へ渡す操作なので分けて持つ。
    const handoffs = conversationTurnFor('idle').handoffs;
    expect(handoffs.map((h) => h.id)).toEqual(['checkin']);
    expect(handoffs[0]?.to).toBe('checkin');
  });

  it('引き渡しを持つのは待機だけ（受付の途中で別シェルへ飛ばさない）', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'idle') continue;
      expect(conversationTurnFor(state).handoffs, state).toEqual([]);
    }
  });

  it('待機の既定ラベルは、画面が実際に使う i18n キーの ja 訳と一致する', () => {
    // #487 / #493 と同じ突き合わせ。契約の既定が辞書とズレると、注入を忘れた箇所で
    // 別の文言が出る。
    const turn = conversationTurnFor('idle');
    expect(turn.answers.map((a) => a.label)).toEqual([
      ja('kiosk.action.callStaff.label'),
      ja('kiosk.action.department.label'),
      ja('kiosk.action.delivery.label'),
      ja('kiosk.action.other.label'),
    ]);
    expect(turn.handoffs.map((h) => h.label)).toEqual([ja('kiosk.action.checkin.label')]);
  });

  it('入口回答も「許可済みアクション」の不変条件に従う（待機で start が許可されている）', () => {
    for (const answer of conversationTurnFor('idle').answers) {
      expect(isActionAllowed('idle', answer.intent), answer.id).toBe(true);
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

  it('確認画面(confirming)では 戻る を出さない（フッターの「修正する」と二重になる・#240/#325）', () => {
    // 確認画面は短い要約で、フッターの「修正する」(confirm-back) が常に到達可能。
    // 常設バーの 戻る と二重になるため意図的に抑制している。契約がこれを反映していないと、
    // 画面を ConversationTurnView へ配線した時点で #240 の dedup が退行する。
    const actions = escapeHatchActionsFor('confirming').map((h) => h.action);
    expect(actions).not.toContain('back');
    expect(actions).toContain('reset');
  });

  it('内容がビューポートを超え得る画面では 戻る を残す（唯一の戻る導線・#325）', () => {
    // selectingTarget（担当者一覧）/ inputVisitorInfo（入力フォーム）はコンテンツ側の
    // 戻るを #325 で撤去したため、sticky な常設バーの 戻る が唯一の戻る導線になる。
    for (const state of ['selectingTarget', 'inputVisitorInfo'] as const) {
      expect(escapeHatchActionsFor(state).map((h) => h.action), state).toContain('back');
    }
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

  // #422 地ならし: 契約の既定 answers は「component が locale 解決値を注入しない場合の
  // ja フォールバック」（下の注入テスト参照）。フォールバックである以上、**画面が実際に
  // 出している文言と一致していなければならない**。ズレたまま画面を ConversationTurnView へ
  // 配線すると、注入を忘れた箇所で別の文言が出る。
  //
  // 逃げ道（#486）・inputModes（#481）と同じ乖離が answers にも在ったため、ここで
  // 辞書と突き合わせて固定する。
  it('既定 answers の ja 文言は、画面が実際に使う i18n キーの ja 訳と一致する', () => {
    const expected: Partial<Record<ReceptionState, readonly string[]>> = {
      selectingPurpose: [
        ja('reception.purpose.meeting'),
        ja('reception.purpose.delivery'),
        ja('reception.purpose.interview'),
        ja('reception.purpose.other'),
      ],
      // 確認画面の主 CTA（reception-screens.tsx の confirm-call）。
      confirming: [ja('reception.callWithThis')],
      // 結果画面の代替導線（use-fallback）。
      timeout: [ja('reception.altContact')],
      failed: [ja('reception.altContact')],
      // 通話中の完了 CTA（complete）。
      connected: [ja('reception.finishReception')],
    };
    for (const [state, labels] of Object.entries(expected)) {
      const actual = conversationTurnFor(state as ReceptionState).answers.map((a) => a.label);
      expect(actual, state).toEqual(labels);
    }
  });

  it('既定 message の ja 文言は、画面の主指示（screen__title）と一致する', () => {
    // 契約の message は「その画面の主指示（見出し相当）」（#324 の役割分担）。実装では
    // 各画面の `<h1 className="screen__title">` がそれに当たる。ズレたまま配線すると、
    // 注入を忘れた箇所で見出しが変わる。
    //
    // 主指示を持たない画面（結果系は ResultPanel の message で、`{target}` の
    // 差し込みを含むため契約の静的文言とは対応づかない）は対象外。
    const expected: Partial<Record<ReceptionState, string>> = {
      idle: ja('reception.purposePrompt'),
      selectingPurpose: ja('reception.purposeDetailPrompt'),
      selectingTarget: ja('reception.targetPrompt'),
      inputVisitorInfo: ja('reception.visitorInfoPrompt'),
      confirming: ja('reception.confirm'),
    };
    for (const [state, text] of Object.entries(expected)) {
      expect(conversationTurnFor(state as ReceptionState).message.displayText, state).toBe(text);
    }
  });

  it('フォールバック画面は既定 answers を持たない（コンテンツは案内のみ・#325）', () => {
    // FallbackView は CTA を一切持たない。後退は逃げ道バー（escape-reset）へ一本化した
    // ため、コンテンツは代替案内メッセージのみ。契約が answers を返すと、配線した時点で
    // 画面にボタンが増える（#325 の決定が退行する）。
    expect(conversationTurnFor('fallback').answers).toEqual([]);
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

// =============================================================================
// #361 QR 受付シェル統一: CheckinState を会話ターンとして提示する契約
// -----------------------------------------------------------------------------
// QR 受付(CheckinFlow)を KioskFlow と同じアバター継続レール・字幕・逃げ道シェルで提示する
// ための表示契約。真実源は本モジュール（ui-contract.ts）に一本化し、進行の真実源は
// 状態機械（domain/checkin/state.ts）に委ねる（発信は confirming の CONFIRM のみ）。
// =============================================================================
describe('checkin ui-contract: checkinConversationTurnFor (#361 QRシェル統一)', () => {
  it('全 CHECKIN_STATES から構造的に妥当な CheckinTurnView を生成する', () => {
    for (const state of CHECKIN_STATES) {
      const turn = checkinConversationTurnFor(state);
      expect(turn.stateKey).toBe(state);
      // アバターは ReceptionState 代理経由で導出（AvatarGuide をそのまま再利用できる）。
      expect(RECEPTION_STATES).toContain(turn.avatar.proxyState);
      expect(turn.avatar.proxyState).toBe(checkinAvatarProxyState(state));
      expect(AVATAR_PRESENCES).toContain(turn.avatar.presence);
      expect(AVATAR_EMOTIONS).toContain(turn.avatar.emotion);
      expect(turn.avatar.motionKey).toBe(motionKeyForState(turn.avatar.proxyState));
      // 字幕: semanticKey と displayText は非空。
      expect(CHECKIN_MESSAGE_KEYS).toContain(turn.message.semanticKey);
      expect(turn.message.semanticKey).toBe(checkinMessageKeyFor(state));
      expect(turn.message.displayText.length).toBeGreaterThan(0);
      // 導出値との一致。
      expect(turn.inputModes).toEqual(checkinInputModesFor(state));
      expect(turn.requiresExplicitConfirmation).toBe(checkinRequiresExplicitConfirmation(state));
      expect(turn.escapeHatches).toEqual(checkinEscapeHatchesFor(state));
    }
  });

  it('タッチはすべてのターンで必ず提示される（音声/QR/カメラが不可でもタッチで完走できる）', () => {
    for (const state of CHECKIN_STATES) {
      expect(checkinConversationTurnFor(state).inputModes).toContain('touch');
    }
  });

  it('QR は読み取りだけで発信しない: 発信の明示確認は confirming のみ（scan/resolve では要求しない）', () => {
    for (const state of CHECKIN_STATES) {
      const expected = state === 'confirming';
      expect(checkinConversationTurnFor(state).requiresExplicitConfirmation).toBe(expected);
    }
    // 読み取り(scanning) / 取得(resolving) からは発信確認を求めない。
    expect(checkinRequiresExplicitConfirmation('scanning')).toBe(false);
    expect(checkinRequiresExplicitConfirmation('resolving')).toBe(false);
  });

  it('発信確認の不変条件は状態機械に紐づく（confirming の CONFIRM だけが calling へ進む）', () => {
    for (const state of CHECKIN_STATES) {
      const goesToCalling = checkinTransition(state, 'CONFIRM') === 'calling';
      expect(checkinRequiresExplicitConfirmation(state)).toBe(goesToCalling);
    }
  });

  it('qr-scan ターン(scanning)は QR を入力手段に持ち、発信確認は不要（読み取りのみ）', () => {
    const turn = checkinConversationTurnFor('scanning');
    expect(turn.inputModes).toContain('qr');
    expect(turn.requiresExplicitConfirmation).toBe(false);
    // 読み取りレールでもアバターは付き添う（companion）。
    expect(turn.avatar.presence).toBe('companion');
  });

  it('qr-confirm ターン(confirming)は発信の明示タッチ確認を要求し、QR は入力手段にしない', () => {
    const turn = checkinConversationTurnFor('confirming');
    expect(turn.requiresExplicitConfirmation).toBe(true);
    expect(turn.inputModes).toEqual(['touch']);
  });

  it('idle は入口のため逃げ道を出さない / アバターはヒーロー(primary)', () => {
    const turn = checkinConversationTurnFor('idle');
    expect(turn.escapeHatches).toEqual([]);
    expect(turn.avatar.presence).toBe('primary');
  });

  it('idle 以外の全ターンでアバターは継続レール(companion)として付き添う', () => {
    for (const state of CHECKIN_STATES) {
      if (state === 'idle') continue;
      expect(checkinConversationTurnFor(state).avatar.presence).toBe('companion');
    }
  });

  it('各エラー結果(期限切れ/使用済み/取消/読取失敗/カメラ不可/通信断)は通常受付へ切替(USE_MANUAL)の逃げ道を持つ', () => {
    for (const state of CHECKIN_ERROR_STATES) {
      const events = checkinEscapeHatchesFor(state).map((h) => h.event);
      expect(events).toContain('USE_MANUAL');
    }
  });

  it('受付方法選択(selectingMethod)は通常受付(CHOOSE_MANUAL)へ切替できる', () => {
    const events = checkinEscapeHatchesFor('selectingMethod').map((h) => h.event);
    expect(events).toContain('CHOOSE_MANUAL');
  });

  it('終端(completed/cancelled/manualFallback)は最初に戻る(RESET)を提示する', () => {
    for (const state of CHECKIN_TERMINAL_STATES) {
      const events = checkinEscapeHatchesFor(state).map((h) => h.event);
      expect(events).toContain('RESET');
    }
  });

  it('逃げ道イベントは RESET を除き必ず状態機械で許可されている（存在しない遷移を出さない）', () => {
    for (const state of CHECKIN_STATES) {
      for (const { event } of checkinEscapeHatchesFor(state)) {
        if (event === 'RESET') continue;
        expect(checkinTransition(state, event)).not.toBeNull();
      }
    }
  });

  it('displayText は呼び出し側が locale 解決済みの値を注入できる（domain は component に依存しない）', () => {
    const turn = checkinConversationTurnFor('scanning', {
      message: { displayText: 'Hold your QR code to the camera.' },
    });
    expect(turn.message.displayText).toBe('Hold your QR code to the camera.');
  });

  it('avatar proxy は各 CheckinState を有効な ReceptionState へ写す（AvatarGuide 再利用のため）', () => {
    for (const state of CHECKIN_STATES) {
      expect(RECEPTION_STATES).toContain(checkinAvatarProxyState(state));
    }
  });
});

describe('reception ui-contract: 常設要素の領域 (#422 inc5-c 増分 2)', () => {
  it('領域はちょうど 3 つ（案内・回答対象・ヘルプ）', () => {
    // #422 の AC「常設要素を原則 3 領域以内へ整理」。語彙が増えたらここで落ちる。
    expect([...PERSISTENT_REGIONS]).toEqual(['guidance', 'answers', 'help']);
  });

  it('契約が持つターン要素はすべて領域に属する（帰属不明の要素を作らない）', () => {
    // ConversationTurnView の各部が、来訪者から見てどの領域に出るかを宣言する。
    // 契約が持たない常設要素（言語切替・退館リンク・アクセシビリティメニュー）は
    // component 層の登録簿が持つ（domain は component の存在を知らない）。
    const turn = conversationTurnFor('idle');
    const parts = ['avatar', 'message', 'answers', 'handoffs', 'escapeHatches'] as const;
    for (const part of parts) {
      expect(turn[part], part).toBeDefined();
      expect(PERSISTENT_REGIONS, part).toContain(regionOfTurnPart(part));
    }
  });

  it('回答と引き渡しは同じ領域（来訪者には並んだカードとして見える）', () => {
    // 待機画面では入口カードと QR 受付が同じカード列に並ぶ。押した結果は違うが
    // （回答は状態機械、引き渡しは別シェル）、領域としては同じ「回答対象」。
    expect(regionOfTurnPart('answers')).toBe('answers');
    expect(regionOfTurnPart('handoffs')).toBe('answers');
  });

  it('アバターと字幕は案内、逃げ道はヘルプ', () => {
    expect(regionOfTurnPart('avatar')).toBe('guidance');
    expect(regionOfTurnPart('message')).toBe('guidance');
    expect(regionOfTurnPart('escapeHatches')).toBe('help');
  });
});
