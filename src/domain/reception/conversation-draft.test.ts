import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationDraftAfterTransition,
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
import { RECEPTION_EVENTS, RECEPTION_STATES, transition, type ReceptionState } from './state';

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

const ambiguousFrom = <T>(source: ConversationSlotSource, ...candidates: T[]): ConversationSlot<T> => ({
  kind: 'ambiguous',
  candidates,
  evidence: { source, certainty: 'ambiguous' },
});

/** 表示されない文字だけの値（前回 MINOR-1）。ゼロ幅スペース・語結合子・BOM・ソフトハイフン。 */
const INVISIBLE_CHARS = ['\u200B', '\u2060', '\uFEFF', '\u00AD'];
const invisible = INVISIBLE_CHARS.join('');
/** NFD（濁点を分けた形）の「が」。NFC では 1 文字（前回 MINOR-2）。 */
const nfdGa = '\u304B\u3099';

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
  // 音声以外の曖昧（落とされずに残る）。曖昧なまま取得済みとはみなさない（前回 MINOR-3）。
  ambiguousFrom<ReceptionPurposeId>('reservation', 'meeting', 'delivery'),
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
  confirmed({ type: 'staff', id: 'staff-x', label: invisible }),
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
  confirmed(invisible),
  high(` ${invisible} `),
  // NFD で数えると上限を超えるが、NFC では上限ちょうど（有効）。
  confirmed(nfdGa.repeat(VISITOR_NAME_MAX_LENGTH)),
  confirmed(nfdGa.repeat(VISITOR_NAME_MAX_LENGTH + 1)),
];

const COMPANIES: Universe<string> = [
  undefined,
  confirmed('株式会社サンプル'),
  high('株式会社サンプル'),
  confirmed('  '),
  confirmed(invisible),
];

/** 独立したオラクル: 空白とフィクスチャの見えない文字を除いて 1 文字でも残るか。 */
const visible = (text: string): boolean =>
  Array.from(text).some((ch) => ch.trim() !== '' && !INVISIBLE_CHARS.includes(ch));

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
      return s?.kind === 'resolved' && visible(s.value.id) && visible(s.value.label);
    }
    case 'visitorName': {
      const s = draft.visitorName;
      if (s?.kind !== 'resolved' || s.evidence.certainty !== 'confirmed') return false;
      const name = s.value.trim().normalize('NFC');
      return visible(name) && Array.from(name).length <= VISITOR_NAME_MAX_LENGTH;
    }
  }
}

const REQUIRED: readonly RequiredConversationSlot[] = ['purpose', 'target', 'visitorName'];

/** 件数の多い総当たりでは 1 件ずつ expect せず、違反を集めて最後に 1 度だけ比べる（速さのため）。 */
function violationLog() {
  const list: string[] = [];
  const check = (ok: boolean, what: string, ctx: unknown) => {
    if (!ok && list.length < 5) list.push(`${what}: ${JSON.stringify(ctx)}`);
  };
  return { list, check };
}

const PRE_CALL: readonly ReceptionState[] = [
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
];

/** focusOrder の宇宙。既定・並べ替え・狭めたもの・空・重複（前回 MAJOR-2）。 */
const ORDERS: ReadonlyArray<readonly RequiredConversationSlot[] | undefined> = [
  undefined,
  ['purpose', 'target', 'visitorName'],
  ['visitorName', 'purpose', 'target'],
  ['target'],
  ['visitorName'],
  [],
  ['purpose', 'purpose'],
];

describe('nextConversationFocus (#1077 / #1079 / ADR 0011)', () => {
  it('「担当者を呼ぶ」の既定は、何も無ければ target を最初の会話焦点にする', () => {
    expect(nextConversationFocus({}, 'selectingPurpose')).toEqual({ kind: 'collect', slot: 'target' });
  });

  it('inputVisitorInfo では、target が既に取れていれば同じ質問をせず visitorName へ進む', () => {
    expect(
      nextConversationFocus({ purpose: confirmed('meeting'), target: high(suzuki) }, 'inputVisitorInfo'),
    ).toEqual({ kind: 'collect', slot: 'visitorName' });
  });

  it('目的の選択画面では、相手が取れていても氏名を尋ねない（通知より前に尋ねない。ADR 0011 §2 / 前回 MAJOR-2）', () => {
    expect(nextConversationFocus({ target: high(suzuki) }, 'selectingPurpose')).toEqual({
      kind: 'collect',
      slot: 'purpose',
    });
    // 残る不足が氏名だけなら、尋ねることは無い（画面の操作で inputVisitorInfo へ進むのを待つ）。
    expect(
      nextConversationFocus({ purpose: confirmed('meeting'), target: high(suzuki), visitorName: high('張') }, 'selectingTarget'),
    ).toEqual({ kind: 'awaitScreen' });
  });

  it('target が曖昧なら、別の不足 slot を増やす前に候補選択で repair する', () => {
    expect(nextConversationFocus({ target: ambiguous(suzuki, sato) }, 'selectingTarget')).toEqual({
      kind: 'disambiguate',
      slot: 'target',
      candidateCount: 2,
    });
  });

  it('有効な候補が 1 件だけでも自動では確定せず、その 1 件を見せて確かめる（ADR 0011 §3-f / 前回 MINOR-4）', () => {
    const draft: ConversationDraft = { target: ambiguous(suzuki, blankTarget) };
    expect(normalizeConversationDraft(draft).target).toEqual(ambiguous(suzuki));
    expect(nextConversationFocus(draft, 'selectingTarget')).toEqual({
      kind: 'disambiguate',
      slot: 'target',
      candidateCount: 1,
    });
    expect(materializationPlanForDraft('selectingTarget', draft)).toEqual({
      actions: [],
      endState: 'selectingTarget',
    });
  });

  it('音声で高信頼に聞き取った氏名でも、自動では確定せず復唱へ進む (ADR 0011 §3-b)', () => {
    expect(
      nextConversationFocus(
        { purpose: confirmed('meeting'), target: high(suzuki), visitorName: high('張') },
        'inputVisitorInfo',
      ),
    ).toEqual({ kind: 'readback', slot: 'visitorName' });
  });

  it('required slot が全部取得済みなら final confirmation だけを次にする', () => {
    expect(nextConversationFocus(completeDraft(), 'inputVisitorInfo')).toEqual({ kind: 'finalConfirmation' });
  });

  it('音声で取った目的は使わず、目的は画面で選んでもらう (ADR 0011 §1)', () => {
    expect(
      nextConversationFocus(
        { purpose: high('meeting'), target: high(suzuki), visitorName: confirmed('張') },
        'selectingPurpose',
      ),
    ).toEqual({ kind: 'collect', slot: 'purpose' });
  });

  it('entry intent に応じて focus 順を差し替えられる', () => {
    expect(
      nextConversationFocus({}, 'selectingPurpose', { focusOrder: ['purpose', 'target', 'visitorName'] }),
    ).toEqual({ kind: 'collect', slot: 'purpose' });
  });

  it('focusOrder を狭めても、欠けた slot を残したまま最終確認へ進まない（前回 MAJOR-2）', () => {
    for (const focusOrder of [['target'], [], ['target', 'target']] as const) {
      expect(
        nextConversationFocus({ target: confirmed(suzuki), visitorName: confirmed('張') }, 'inputVisitorInfo', {
          focusOrder,
        }),
      ).toEqual({ kind: 'collect', slot: 'purpose' });
    }
  });

  it('受付途中の 4 状態以外では何も尋ねない', () => {
    for (const state of RECEPTION_STATES) {
      if (PRE_CALL.includes(state)) continue;
      expect(nextConversationFocus(completeDraft(), state)).toEqual({ kind: 'awaitScreen' });
      expect(nextConversationFocus({}, state)).toEqual({ kind: 'awaitScreen' });
    }
  });

  /*
   * 不変条件（全 state × 全 draft × 全 focusOrder の総当たり）。
   * - 氏名を尋ねるのは inputVisitorInfo に居るときだけ（ADR 0011 §2）。
   * - 最終確認 ⟺ 受付途中の状態で、必須 slot が全部取得済み（focusOrder に依らない）。
   * - 取得済みの slot を再び尋ねない。尋ねるのは未取得のどれか。
   * - 下界: 受付途中で未取得があり、尋ねられる slot（氏名は inputVisitorInfo のときだけ）が
   *   未取得なら、何も尋ねない（awaitScreen）にはならない。
   */
  it('総当たり: 氏名は inputVisitorInfo でだけ尋ね、揃ったときだけ最終確認へ、取得済みを再質問しない', () => {
    let finals = 0;
    let checked = 0;
    let awaited = 0;
    const kinds = new Set<string>();
    const { list: violations, check } = violationLog();
    for (const draft of allDrafts()) {
      const missing = REQUIRED.filter((key) => !acquired(draft, key));
      check(isDraftReadyForFinalConfirmation(draft) === (missing.length === 0), 'ready', draft);
      for (const state of RECEPTION_STATES) {
        const preCall = PRE_CALL.includes(state);
        const askable = missing.filter((key) => key !== 'visitorName' || state === 'inputVisitorInfo');
        // 受付途中以外は既定の順だけで足りる（順に依らず awaitScreen）。
        for (const focusOrder of preCall ? ORDERS : [undefined]) {
          const focus = nextConversationFocus(draft, state, focusOrder ? { focusOrder } : {});
          const ctx = { state, focusOrder, draft, focus };
          checked += 1;
          kinds.add(focus.kind);
          check((focus.kind === 'finalConfirmation') === (preCall && missing.length === 0), 'final', ctx);
          if (focus.kind === 'finalConfirmation') {
            finals += 1;
          } else if (focus.kind === 'awaitScreen') {
            awaited += 1;
            check(!(preCall && askable.length > 0), 'await-lower-bound', ctx);
          } else {
            check(state === 'inputVisitorInfo' || focus.slot !== 'visitorName', 'name-only-on-input', ctx);
            check(askable.includes(focus.slot), 'askable', ctx);
            if (focus.kind === 'readback') {
              check(focus.slot === 'visitorName' && draft.visitorName?.kind === 'resolved', 'readback', ctx);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
    // 空虚に満たしていないこと。
    expect(checked).toBe(
      (PRE_CALL.length * ORDERS.length + RECEPTION_STATES.length - PRE_CALL.length) *
        PURPOSES.length *
        TARGETS.length *
        NAMES.length *
        COMPANIES.length,
    );
    expect(finals).toBeGreaterThan(0);
    expect(awaited).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(['awaitScreen', 'collect', 'disambiguate', 'finalConfirmation', 'readback']);
  });

  it('総当たり: 音声も有人支援も無い前提でも、inputVisitorInfo で氏名だけが欠けていれば必ずキーボード入力 (collect) を返す (ADR 0011 §4)', () => {
    for (const name of NAMES) {
      const draft: ConversationDraft = {
        purpose: confirmed('meeting'),
        target: confirmed(suzuki),
        ...(name ? { visitorName: name } : {}),
      };
      const focus = nextConversationFocus(draft, 'inputVisitorInfo');
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
    for (const state of PRE_CALL) {
      for (const draft of allDrafts()) {
        const focus = nextConversationFocus(draft, state);
        if (focus.kind !== 'disambiguate') continue;
        const slot = normalizeConversationDraft(draft)[focus.slot];
        expect(slot?.kind).toBe('ambiguous');
        if (slot?.kind !== 'ambiguous') continue;
        expect(slot.candidates.length).toBe(focus.candidateCount);
        expect(focus.candidateCount).toBeGreaterThan(0);
      }
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

  it('high は confirmed で上書きでき、同じ強さなら後から来た値が勝つ（前回 MAJOR-1）', () => {
    expect(mergeConversationDraft({ target: high(suzuki) }, { target: confirmed(sato) }).target).toEqual(
      confirmed(sato),
    );
    // 「いいえ」の後に言い直した値は、前の高信頼の値に負けない。
    expect(mergeConversationDraft({ target: high(suzuki) }, { target: high(sato) }).target).toEqual(high(sato));
    // タッチで選び直した相手は、前にタッチで選んだ相手に負けない。
    expect(
      mergeConversationDraft({ target: confirmed(suzuki) }, { target: confirmed(sato) }).target,
    ).toEqual(confirmed(sato));
  });

  it('曖昧な値は、既に分かっている高信頼の値を曖昧へ戻さない。高信頼の言い直しは曖昧を解消する（前回 MINOR-3）', () => {
    expect(mergeConversationDraft({ target: high(suzuki) }, { target: ambiguous(suzuki, sato) }).target).toEqual(
      high(suzuki),
    );
    expect(mergeConversationDraft({ target: ambiguous(suzuki, sato) }, { target: high(sato) }).target).toEqual(
      high(sato),
    );
  });

  it('復唱で確定した氏名をキーボードで直したら直した値が残り、その後の音声は上書きしない（ADR 0011 §3-c / 前回 MAJOR-1）', () => {
    const voiced = mergeConversationDraft({}, { visitorName: confirmed('Taro', 'voice') });
    const typed = mergeConversationDraft(voiced, { visitorName: confirmed('Taro Yamada', 'touch') });
    expect(typed.visitorName).toEqual(confirmed('Taro Yamada', 'touch'));
    for (const late of [confirmed('Taro', 'voice'), high('Taro')]) {
      expect(mergeConversationDraft(typed, { visitorName: late }).visitorName).toEqual(
        confirmed('Taro Yamada', 'touch'),
      );
    }
  });

  it('「いいえ」の後に言い直した氏名は、前の高信頼の氏名に負けない（前回 MAJOR-1）', () => {
    const first = mergeConversationDraft({}, { visitorName: high('Taro') });
    const reasked = mergeConversationDraft(first, { visitorName: high('Jiro') });
    expect(reasked.visitorName).toEqual(high('Jiro'));
  });

  /*
   * 不変条件（有効な値どうしの全組合せ）。実装の順位関数を使わず、仕様の文から直接書く。
   * - 画面での明示（タッチ・キーボード・QR・予約）で確定した値は、後から来れば必ず残る。
   * - 音声の値は、画面で明示して確定した値を上書きしない。
   * - 出所の種類（音声か画面か）と確信度が同じなら、後から来た値が残る。
   * - 高信頼は確定を、曖昧は解決済みを上書きしない。解決済みは曖昧を解消する。
   * - 結果は常に current か incoming のどちらか。
   */
  it('総当たり: 後から来た明示の値は必ず残り、弱い値は強い値を上書きしない（前回 MAJOR-1）', () => {
    const SOURCES: readonly ConversationSlotSource[] = ['touch', 'voice', 'qr', 'reservation'];
    const slots: ConversationSlot<ConversationTarget>[] = [];
    for (const source of SOURCES) {
      for (const value of [suzuki, sato]) {
        slots.push(confirmed(value, source), high(value, source));
      }
      slots.push(ambiguousFrom(source, suzuki, sato));
    }
    const screenConfirmed = (x: ConversationSlot<unknown>) =>
      x.kind === 'resolved' && x.evidence.certainty === 'confirmed' && x.evidence.source !== 'voice';
    const isConfirmed = (x: ConversationSlot<unknown>) => x.kind === 'resolved' && x.evidence.certainty === 'confirmed';
    const isHigh = (x: ConversationSlot<unknown>) => x.kind === 'resolved' && x.evidence.certainty === 'high';
    let replaced = 0;
    for (const c of slots) {
      for (const i of slots) {
        const merged = mergeConversationDraft({ target: c }, { target: i }).target;
        expect([c, i]).toContainEqual(merged);
        if (JSON.stringify(merged) === JSON.stringify(i)) replaced += 1;

        if (screenConfirmed(i)) expect(merged).toEqual(i);
        if (screenConfirmed(c) && i.evidence.source === 'voice') expect(merged).toEqual(c);
        if (
          c.evidence.certainty === i.evidence.certainty &&
          (c.evidence.source === 'voice') === (i.evidence.source === 'voice')
        ) {
          expect(merged).toEqual(i);
        }
        if (isConfirmed(c) && isHigh(i)) expect(merged).toEqual(c);
        if (c.kind === 'resolved' && i.kind === 'ambiguous') expect(merged).toEqual(c);
        if (c.kind === 'ambiguous' && i.kind === 'resolved') expect(merged).toEqual(i);
      }
    }
    // 空虚でないこと（置き換わる組も、保たれる組も実在する）。
    expect(replaced).toBeGreaterThan(0);
    expect(replaced).toBeLessThan(slots.length * slots.length);
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
    expect(nextConversationFocus(after, 'inputVisitorInfo')).toEqual({ kind: 'collect', slot: 'visitorName' });
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
    const { list: violations, check } = violationLog();
    for (const initial of RECEPTION_STATES) {
      for (const draft of allDrafts()) {
        const plan = materializationPlanForDraft(initial, draft);
        const ctx = { initial, draft, plan };

        let state: ReceptionState | null = initial;
        for (const action of plan.actions) {
          check(action.type === 'SELECT_TARGET', 'action-type', ctx);
          check(visible(action.target.id) && visible(action.target.label), 'valid-target', ctx);
          state = state === null ? null : transition(state, action.type);
          check(state !== null, 'allowed-transition', ctx);
        }
        check(plan.endState === state, 'endState-replay', ctx);
        check(plan.actions.length === 0 || plan.endState === 'inputVisitorInfo', 'stop-at-input', ctx);

        const expectPrefill = plan.endState === 'inputVisitorInfo' && acquired(draft, 'visitorName');
        check((plan.visitorNamePrefill !== undefined) === expectPrefill, 'prefill-when', ctx);
        if (expectPrefill) {
          prefilled += 1;
          check(
            draft.visitorName?.kind === 'resolved' && plan.visitorNamePrefill === draft.visitorName.value.trim(),
            'prefill-value',
            ctx,
          );
        }

        if (initial === 'selectingTarget' && acquired(draft, 'target')) {
          advanced += 1;
          check(
            plan.endState === 'inputVisitorInfo' &&
              plan.actions.length === 1 &&
              draft.target?.kind === 'resolved' &&
              plan.actions[0]?.target === draft.target.value,
            'advance-lower-bound',
            ctx,
          );
        } else if (initial !== 'inputVisitorInfo') {
          check(plan.actions.length === 0, 'no-action', ctx);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(advanced).toBeGreaterThan(0);
    expect(prefilled).toBeGreaterThan(0);
  });
});

describe('状態の遷移と draft (ADR 0011 §3-c・§6 / 前回 MAJOR-1)', () => {
  const BACK_EDGES = RECEPTION_STATES.flatMap((from) => {
    const to = transition(from, 'BACK');
    return to === null ? [] : [{ from, to }];
  });

  it('総当たり: 受付途中の 4 状態以外（RESET・無操作リセット後の idle、キャンセル、完了、発信以降）へ移ったら必ず空にする', () => {
    let kept = 0;
    for (const from of RECEPTION_STATES) {
      for (const event of RECEPTION_EVENTS) {
        const to = transition(from, event) ?? from;
        const after = conversationDraftAfterTransition(completeDraft(), from, event);
        if (!PRE_CALL.includes(to)) {
          expect(after).toEqual({});
        } else if (event !== 'BACK' || transition(from, event) === null) {
          // 下界: 受付途中の前進と、遷移しないイベント（遷移表に無い BACK を含む）では、
          // 取得済みの情報を捨てない。
          kept += 1;
          expect(after).toEqual(normalizeConversationDraft(completeDraft()));
          expect(isDraftReadyForFinalConfirmation(after)).toBe(true);
        }
      }
    }
    expect(kept).toBeGreaterThan(0);
  });

  it('受付途中でも、音声から埋めない値（目的・会社名）や無効な値は保持しない', () => {
    const draft: ConversationDraft = {
      ...completeDraft(),
      purpose: high('meeting'),
      company: high('株式会社サンプル'),
      target: confirmed(blankTarget),
    };
    for (const from of PRE_CALL) {
      // COMPLETE は受付途中のどの状態でも遷移しない（状態は変わらない）。
      expect(transition(from, 'COMPLETE')).toBeNull();
      expect(conversationDraftAfterTransition(draft, from, 'COMPLETE')).toEqual({
        visitorName: confirmed('張', 'voice'),
      });
    }
  });

  it('戻った画面とその先の slot を捨て、手前の画面の slot は残す', () => {
    const full: ConversationDraft = { ...completeDraft(), company: confirmed('株式会社サンプル') };
    expect(conversationDraftAfterTransition(full, 'confirming', 'BACK')).toEqual({
      purpose: full.purpose,
      target: full.target,
    });
    expect(conversationDraftAfterTransition(full, 'inputVisitorInfo', 'BACK')).toEqual({ purpose: full.purpose });
    expect(conversationDraftAfterTransition(full, 'selectingTarget', 'BACK')).toEqual({});
  });

  /*
   * 不変条件（BACK の全辺 × 全 draft）。
   * - 戻った直後の計画は、前へ進める action も prefill も含まない（来訪者を押し戻さない）。
   * - 下界: 戻った画面より手前の画面で埋める slot は、正規化した値のまま残る。
   */
  it('総当たり: 戻った直後の計画には前へ進める action も prefill も無い', () => {
    let checked = 0;
    const { list: violations, check } = violationLog();
    for (const { from, to } of BACK_EDGES) {
      for (const draft of allDrafts()) {
        const after = conversationDraftAfterTransition(draft, from, 'BACK');
        const plan = materializationPlanForDraft(to, after);
        const ctx = { from, draft, after, plan };
        checked += 1;
        check(plan.actions.length === 0, 'no-forward-action', ctx);
        check(plan.endState === to, 'endState', ctx);
        check(plan.visitorNamePrefill === undefined, 'no-prefill', ctx);

        const normalized = normalizeConversationDraft(draft);
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        if (to === 'inputVisitorInfo') {
          check(same(after.purpose, normalized.purpose) && same(after.target, normalized.target), 'keep-earlier', ctx);
        }
        if (to === 'selectingTarget') check(same(after.purpose, normalized.purpose), 'keep-earlier', ctx);
      }
    }
    expect(violations).toEqual([]);
    expect(BACK_EDGES.map((e) => e.to).sort()).toEqual(['inputVisitorInfo', 'selectingPurpose', 'selectingTarget']);
    expect(checked).toBeGreaterThan(0);
  });

  it('タッチで A を選んで戻ったら、A へ押し戻さず、選び直した B で進む（前回 MAJOR-1 の実測 1・2）', () => {
    let state: ReceptionState = 'selectingTarget';
    let draft: ConversationDraft = mergeConversationDraft(
      { purpose: confirmed('meeting'), visitorName: confirmed('張', 'voice') },
      { target: confirmed(suzuki) },
    );
    draft = conversationDraftAfterTransition(draft, state, 'SELECT_TARGET');
    state = 'inputVisitorInfo';
    draft = conversationDraftAfterTransition(draft, state, 'BACK');
    state = 'selectingTarget';
    expect(materializationPlanForDraft(state, draft)).toEqual({ actions: [], endState: 'selectingTarget' });

    draft = mergeConversationDraft(draft, { target: confirmed(sato) });
    expect(materializationPlanForDraft(state, draft).actions).toEqual([{ type: 'SELECT_TARGET', target: sato }]);
  });

  it('確認画面から戻っても、キーボードで直した氏名を音声の氏名で上書きしない（前回 MAJOR-1 の実測 3）', () => {
    let draft: ConversationDraft = {
      purpose: confirmed('meeting'),
      target: confirmed(suzuki),
      visitorName: confirmed('Taro', 'voice'),
    };
    // キーボードで直して送信する。
    draft = mergeConversationDraft(draft, { visitorName: confirmed('Taro Yamada', 'touch') });
    draft = conversationDraftAfterTransition(draft, 'inputVisitorInfo', 'SUBMIT_VISITOR_INFO');
    expect(draft.visitorName).toEqual(confirmed('Taro Yamada', 'touch'));
    // 確認画面から戻る。
    draft = conversationDraftAfterTransition(draft, 'confirming', 'BACK');
    expect(materializationPlanForDraft('inputVisitorInfo', draft)).toEqual({
      actions: [],
      endState: 'inputVisitorInfo',
    });
  });
});

describe('PII を外へ出さない (ADR 0011 §6)', () => {
  it('総当たり: 会話の焦点には氏名・会社名の値が乗らない', () => {
    for (const draft of allDrafts()) {
      const focus: ConversationFocus = nextConversationFocus(draft, 'inputVisitorInfo');
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
