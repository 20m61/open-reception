import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationDraftForState,
  isDraftReadyForFinalConfirmation,
  materializationPlanForDraft,
  mergeConversationDraft,
  nextConversationFocus,
  normalizeConversationDraft,
  replaceConversationSlot,
  type ConversationDraft,
  type ConversationFocus,
  type ConversationSlot,
  type ConversationSlotSource,
  type ConversationTarget,
  type RequiredConversationSlot,
} from './conversation-draft';
import { VISITOR_NAME_MAX_LENGTH, type ReceptionPurposeId } from './session';
import { RECEPTION_STATES, transition, type ReceptionState } from './state';

const confirmed = <T>(value: T, source: ConversationSlotSource = 'touch'): ConversationSlot<T> => ({
  kind: 'resolved',
  value,
  evidence: { source, certainty: 'confirmed' },
});

const high = <T>(value: T, source: ConversationSlotSource = 'voice'): ConversationSlot<T> => ({
  kind: 'resolved',
  value,
  evidence: { source, certainty: 'high' },
});

const ambiguous = <T>(...candidates: T[]): ConversationSlot<T> => ({
  kind: 'ambiguous',
  candidates,
  evidence: { source: 'voice', certainty: 'ambiguous' },
});

const suzuki: ConversationTarget = { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' };
const sato: ConversationTarget = { type: 'staff', id: 'staff-sato', label: '佐藤 花子', sublabel: '営業部' };
const blankTarget: ConversationTarget = { type: 'staff', id: ' ', label: ' ' };

/** 受付として揃った draft。氏名は復唱で肯定された（confirmed）ものとする。 */
const completeDraft = (): ConversationDraft => ({
  purpose: confirmed<ReceptionPurposeId>('meeting'),
  target: high(suzuki),
  visitorName: confirmed('張', 'voice'),
});

/* ------------------------------------------------------------------------------------------
 * 総当たり用の値の宇宙。
 * 各 slot について「有効」「無効」「曖昧（有効・無効混在）」「出所の違い」を網羅する。
 * ---------------------------------------------------------------------------------------- */

type Universe<T> = ReadonlyArray<ConversationSlot<T> | undefined>;

const PURPOSES: Universe<ReceptionPurposeId> = [
  undefined,
  confirmed('meeting'),
  confirmed('delivery', 'qr'),
  high('interview', 'reservation'),
  // 音声の目的は ADR 0011 で扱わない（落とす）。
  high('meeting'),
  confirmed('meeting', 'voice'),
  ambiguous<ReceptionPurposeId>('meeting', 'delivery'),
  // 無効値（型の外から来た値）。
  confirmed('bogus' as ReceptionPurposeId),
  ambiguous('bogus' as ReceptionPurposeId),
];

const TARGETS: Universe<ConversationTarget> = [
  undefined,
  confirmed(suzuki),
  high(sato),
  confirmed(blankTarget),
  high(blankTarget),
  ambiguous(suzuki, sato),
  ambiguous(suzuki, blankTarget),
  ambiguous(blankTarget),
];

const longName = 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1);
const NAMES: Universe<string> = [
  undefined,
  confirmed('張', 'voice'),
  confirmed(' 李 ', 'touch'),
  high('王'),
  confirmed('   '),
  high('   '),
  confirmed(longName),
  high(longName),
  ambiguous('張', '李'),
  ambiguous(' '),
];

const COMPANIES: Universe<string> = [
  undefined,
  confirmed('株式会社サンプル'),
  high('株式会社サンプル'),
  confirmed('  '),
];

function* allDrafts(): Generator<ConversationDraft> {
  for (const purpose of PURPOSES)
    for (const target of TARGETS)
      for (const visitorName of NAMES)
        for (const company of COMPANIES) {
          yield {
            ...(purpose ? { purpose } : {}),
            ...(target ? { target } : {}),
            ...(visitorName ? { visitorName } : {}),
            ...(company ? { company } : {}),
          };
        }
}

/** 独立したオラクル: 実装の述語を使わず、仕様から直接「取得済み」を判定する。 */
function acquired(draft: ConversationDraft, key: RequiredConversationSlot): boolean {
  switch (key) {
    case 'purpose': {
      const s = draft.purpose;
      return (
        s?.kind === 'resolved' &&
        s.evidence.source !== 'voice' &&
        ['meeting', 'delivery', 'interview', 'other'].includes(s.value)
      );
    }
    case 'target': {
      const s = draft.target;
      return s?.kind === 'resolved' && s.value.id.trim() !== '' && s.value.label.trim() !== '';
    }
    case 'visitorName': {
      const s = draft.visitorName;
      if (s?.kind !== 'resolved' || s.evidence.certainty !== 'confirmed') return false;
      const name = s.value.trim();
      return name !== '' && Array.from(name).length <= VISITOR_NAME_MAX_LENGTH;
    }
  }
}

const REQUIRED: readonly RequiredConversationSlot[] = ['purpose', 'target', 'visitorName'];

describe('nextConversationFocus (#1077 / #1079 / ADR 0011)', () => {
  it('「担当者を呼ぶ」の既定は、何も無ければ target を最初の会話焦点にする', () => {
    expect(nextConversationFocus({})).toEqual({ kind: 'collect', slot: 'target' });
  });

  it('target が既に取れていれば同じ質問をせず visitorName へ進む', () => {
    expect(nextConversationFocus({ target: high(suzuki) })).toEqual({
      kind: 'collect',
      slot: 'visitorName',
    });
  });

  it('target が曖昧なら、別の不足 slot を増やす前に候補選択で repair する', () => {
    expect(nextConversationFocus({ target: ambiguous(suzuki, sato) })).toEqual({
      kind: 'disambiguate',
      slot: 'target',
      candidateCount: 2,
    });
  });

  it('音声で高信頼に聞き取った氏名でも、自動では確定せず復唱へ進む (ADR 0011 §3-b)', () => {
    expect(
      nextConversationFocus({ purpose: confirmed('meeting'), target: high(suzuki), visitorName: high('張') }),
    ).toEqual({ kind: 'readback', slot: 'visitorName' });
  });

  it('required slot が全部取得済みなら final confirmation だけを次にする', () => {
    expect(nextConversationFocus(completeDraft())).toEqual({ kind: 'finalConfirmation' });
  });

  it('音声で取った目的は使わず、目的は画面で選んでもらう (ADR 0011 §1)', () => {
    expect(
      nextConversationFocus({ purpose: high('meeting'), target: high(suzuki), visitorName: confirmed('張') }),
    ).toEqual({ kind: 'collect', slot: 'purpose' });
  });

  it('entry intent に応じて focus 順を差し替えられる', () => {
    expect(nextConversationFocus({}, { focusOrder: ['purpose', 'target', 'visitorName'] })).toEqual({
      kind: 'collect',
      slot: 'purpose',
    });
  });

  /*
   * 不変条件（総当たり）。
   * - 下界: 氏名が未取得なら、他に何が欠けていても visitorName は必ず collect / readback /
   *   disambiguate のどれか（＝キーボードで埋められる）として到達可能であり、行き止まりにならない。
   * - 取得済みの slot を再び尋ねない。
   * - 全部取得済み ⟺ finalConfirmation。
   */
  it('総当たり: どの draft でも行き止まりにならず、取得済みを再質問せず、揃ったときだけ最終確認へ', () => {
    const allowedKinds = new Set(['collect', 'disambiguate', 'readback', 'finalConfirmation']);
    let finals = 0;
    let checked = 0;
    for (const draft of allDrafts()) {
      const focus = nextConversationFocus(draft);
      checked += 1;
      expect(allowedKinds.has(focus.kind)).toBe(true);

      const allAcquired = REQUIRED.every((key) => acquired(draft, key));
      expect(focus.kind === 'finalConfirmation').toBe(allAcquired);
      if (focus.kind === 'finalConfirmation') {
        finals += 1;
        continue;
      }
      // 取得済みの slot を再質問しない。
      expect(acquired(draft, focus.slot)).toBe(false);
      // 下界: 未取得の slot が 1 つでもあれば、焦点はその未取得のどれかを指す。
      expect(REQUIRED.filter((key) => !acquired(draft, key))).toContain(focus.slot);
      // readback は「高信頼の氏名」だけ。
      if (focus.kind === 'readback') {
        expect(focus.slot).toBe('visitorName');
        expect(draft.visitorName?.kind).toBe('resolved');
      }
    }
    // 空虚に満たしていないこと（最終確認へ到達する draft も実在する）。
    expect(checked).toBe(PURPOSES.length * TARGETS.length * NAMES.length * COMPANIES.length);
    expect(finals).toBeGreaterThan(0);
  });

  it('総当たり: 音声も有人支援も無い前提でも、氏名だけが欠けていれば必ずキーボード入力 (collect) を返す (ADR 0011 §4)', () => {
    for (const name of NAMES) {
      const draft: ConversationDraft = {
        purpose: confirmed('meeting'),
        target: confirmed(suzuki),
        ...(name ? { visitorName: name } : {}),
      };
      const focus = nextConversationFocus(draft);
      if (acquired(draft, 'visitorName')) {
        expect(focus).toEqual({ kind: 'finalConfirmation' });
      } else if (draft.visitorName?.kind === 'resolved' && focus.kind === 'readback') {
        expect(focus.slot).toBe('visitorName');
      } else {
        expect(focus).toEqual({ kind: 'collect', slot: 'visitorName' });
      }
    }
  });

  it('candidateCount は来訪者に見せる候補の数と一致する (前回 MINOR-2)', () => {
    for (const draft of allDrafts()) {
      const focus = nextConversationFocus(draft);
      if (focus.kind !== 'disambiguate') continue;
      const slot = normalizeConversationDraft(draft)[focus.slot];
      expect(slot?.kind).toBe('ambiguous');
      if (slot?.kind !== 'ambiguous') continue;
      expect(slot.candidates.length).toBe(focus.candidateCount);
      expect(focus.candidateCount).toBeGreaterThan(0);
    }
  });
});

describe('multi-slot merge / repair (#1077)', () => {
  it('1 発話から target + visitorName をまとめて取り込める', () => {
    const merged = mergeConversationDraft({ purpose: confirmed('meeting') }, {
      target: high(suzuki),
      visitorName: high('張'),
    });
    expect(merged.target).toEqual(high(suzuki));
    expect(merged.visitorName).toEqual(high('張'));
  });

  it('タッチで confirmed 済みの target を後続の voice high で上書きしない', () => {
    expect(mergeConversationDraft({ target: confirmed(suzuki) }, { target: high(sato) }).target).toEqual(
      confirmed(suzuki),
    );
  });

  it('voice ambiguous は後続の明示 touch で resolved にできる', () => {
    expect(
      mergeConversationDraft({ target: ambiguous(suzuki, sato) }, { target: confirmed(sato) }).target,
    ).toEqual(confirmed(sato));
  });

  it('high は confirmed で上書きでき、同順位なら既存値を保つ', () => {
    expect(mergeConversationDraft({ target: high(suzuki) }, { target: confirmed(sato) }).target).toEqual(
      confirmed(sato),
    );
    expect(mergeConversationDraft({ target: high(suzuki) }, { target: high(sato) }).target).toEqual(
      high(suzuki),
    );
    expect(
      mergeConversationDraft({ target: confirmed(suzuki) }, { target: confirmed(sato) }).target,
    ).toEqual(confirmed(suzuki));
  });

  it('明示訂正は target だけを置き換え、purpose / name を失わない', () => {
    const before = completeDraft();
    const after = replaceConversationSlot(before, 'target', confirmed(sato));
    expect(after.target).toEqual(confirmed(sato));
    expect(after.purpose).toEqual(before.purpose);
    expect(after.visitorName).toEqual(before.visitorName);
  });

  it('slot を消して再質問対象へ戻しても他 slot は維持する', () => {
    const before = completeDraft();
    const after = replaceConversationSlot(before, 'visitorName', undefined);
    expect(after.visitorName).toBeUndefined();
    expect(after.target).toEqual(before.target);
    expect(after.purpose).toEqual(before.purpose);
    expect(nextConversationFocus(after)).toEqual({ kind: 'collect', slot: 'visitorName' });
  });

  it('無効な値での訂正は slot を消す（無効値を draft に残さない）', () => {
    const after = replaceConversationSlot(completeDraft(), 'visitorName', confirmed('  '));
    expect(after.visitorName).toBeUndefined();
    expect(after.target).toEqual(completeDraft().target);
  });
});

describe('materializationPlanForDraft (#1079 / ADR 0011 §1・§2)', () => {
  it('selectingTarget で target が取れていれば SELECT_TARGET を返し、inputVisitorInfo で止まる', () => {
    expect(materializationPlanForDraft('selectingTarget', { target: high(suzuki) })).toEqual({
      actions: [{ type: 'SELECT_TARGET', target: suzuki }],
      endState: 'inputVisitorInfo',
    });
  });

  it('復唱で確定済みの氏名は、inputVisitorInfo に着いたときの prefill として返す（SUBMIT はしない）', () => {
    expect(materializationPlanForDraft('selectingTarget', completeDraft())).toEqual({
      actions: [{ type: 'SELECT_TARGET', target: suzuki }],
      endState: 'inputVisitorInfo',
      visitorNamePrefill: '張',
    });
  });

  it('高信頼でも復唱前の氏名は prefill しない', () => {
    const plan = materializationPlanForDraft('inputVisitorInfo', {
      ...completeDraft(),
      visitorName: high('張'),
    });
    expect(plan).toEqual({ actions: [], endState: 'inputVisitorInfo' });
  });

  it('idle からは何も進めない（START・SELECT_PURPOSE は音声から起こさない）', () => {
    expect(materializationPlanForDraft('idle', completeDraft())).toEqual({ actions: [], endState: 'idle' });
    expect(materializationPlanForDraft('selectingPurpose', completeDraft())).toEqual({
      actions: [],
      endState: 'selectingPurpose',
    });
  });

  it('ambiguous な target は state へ materialize しない', () => {
    expect(materializationPlanForDraft('selectingTarget', { target: ambiguous(suzuki, sato) })).toEqual({
      actions: [],
      endState: 'selectingTarget',
    });
  });

  /*
   * 不変条件（全 state × 全 draft の総当たり）。
   * - 出てくる action は SELECT_TARGET だけ（CONFIRM・SUBMIT_VISITOR_INFO・SELECT_PURPOSE・START を含まない）。
   * - action 列は transition の許可経路だけを通り、endState はその再生結果と一致する。
   * - inputVisitorInfo を飛ばさない: 計画の結果が confirming 以降へ進むことは無い。
   * - 無効・曖昧な target を運ばない。
   * - prefill は「inputVisitorInfo で止まり、かつ氏名が復唱で確定済み」のときだけ、その氏名で出る。
   * - 下界: selectingTarget で target が取得済みなら、必ず inputVisitorInfo まで進む。
   */
  it('総当たり: 許可された経路だけを通り、inputVisitorInfo を飛ばさず、取得済みなら必ずそこまで進む', () => {
    let advanced = 0;
    let prefilled = 0;
    for (const initial of RECEPTION_STATES) {
      for (const draft of allDrafts()) {
        const plan = materializationPlanForDraft(initial, draft);

        let state: ReceptionState = initial;
        for (const action of plan.actions) {
          expect(action.type).toBe('SELECT_TARGET');
          expect(action.target.id.trim()).not.toBe('');
          expect(action.target.label.trim()).not.toBe('');
          const next = transition(state, action.type);
          expect(next).not.toBeNull();
          state = next!;
        }
        expect(plan.endState).toBe(state);
        if (plan.actions.length > 0) expect(plan.endState).toBe('inputVisitorInfo');

        const expectPrefill = plan.endState === 'inputVisitorInfo' && acquired(draft, 'visitorName');
        expect(plan.visitorNamePrefill !== undefined).toBe(expectPrefill);
        if (expectPrefill) {
          prefilled += 1;
          expect(plan.visitorNamePrefill).toBe(
            draft.visitorName?.kind === 'resolved' ? draft.visitorName.value.trim() : '<none>',
          );
        }

        if (initial === 'selectingTarget' && acquired(draft, 'target')) {
          advanced += 1;
          expect(plan.endState).toBe('inputVisitorInfo');
          expect(plan.actions).toEqual([
            { type: 'SELECT_TARGET', target: draft.target?.kind === 'resolved' ? draft.target.value : null },
          ]);
        } else if (initial !== 'inputVisitorInfo') {
          expect(plan.actions).toEqual([]);
        }
      }
    }
    expect(advanced).toBeGreaterThan(0);
    expect(prefilled).toBeGreaterThan(0);
  });
});

describe('draft の破棄 (ADR 0011 §6)', () => {
  const PRE_CALL: readonly ReceptionState[] = [
    'selectingPurpose',
    'selectingTarget',
    'inputVisitorInfo',
    'confirming',
  ];

  it('総当たり: 受付途中の 4 状態以外（RESET・無操作リセット後の idle、キャンセル、完了、発信以降）では必ず空にする', () => {
    const draft = completeDraft();
    for (const state of RECEPTION_STATES) {
      const kept = conversationDraftForState(draft, state);
      if (PRE_CALL.includes(state)) {
        // 下界: 受付途中では取得済みの情報を捨てない。
        expect(kept).toEqual(normalizeConversationDraft(draft));
        expect(isDraftReadyForFinalConfirmation(kept)).toBe(true);
      } else {
        expect(kept).toEqual({});
      }
    }
  });

  it('RESET / CANCEL / COMPLETE で到達する状態はすべて破棄側にある', () => {
    for (const from of RECEPTION_STATES) {
      for (const event of ['RESET', 'CANCEL', 'COMPLETE', 'CONFIRM'] as const) {
        const to = transition(from, event);
        if (to === null) continue;
        expect(conversationDraftForState(completeDraft(), to)).toEqual({});
      }
    }
  });
});

describe('PII を外へ出さない (ADR 0011 §6)', () => {
  it('総当たり: 会話の焦点には氏名・会社名の値が乗らない', () => {
    for (const draft of allDrafts()) {
      const focus: ConversationFocus = nextConversationFocus(draft);
      const serialized = JSON.stringify(focus);
      for (const text of ['張', '李', '王', '株式会社サンプル', 'あ']) {
        expect(serialized).not.toContain(text);
      }
    }
  });

  it('モジュールはログ・計測・I/O に触れない（import は domain/reception の型と状態機械だけ）', () => {
    const source = readFileSync(join(__dirname, 'conversation-draft.ts'), 'utf8');
    expect(source).not.toMatch(/\bconsole\./);
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./session', './state']);
  });
});
