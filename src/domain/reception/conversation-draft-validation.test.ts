import { describe, expect, it } from 'vitest';
import {
  mergeConversationDraft,
  nextConversationFocus,
  normalizeConversationDraft,
  type ConversationDraft,
  type ConversationSlot,
  type ConversationSlotSource,
  type ConversationTarget,
} from './conversation-draft';
import { VISITOR_NAME_MAX_LENGTH, isVisitorNameWithinLimit, type ReceptionPurposeId } from './session';

const resolved = <T>(
  value: T,
  certainty: 'confirmed' | 'high',
  source: ConversationSlotSource = 'touch',
): ConversationSlot<T> => ({ kind: 'resolved', value, evidence: { source, certainty } });

const ambiguous = <T>(...candidates: T[]): ConversationSlot<T> => ({
  kind: 'ambiguous',
  candidates,
  evidence: { source: 'voice', certainty: 'ambiguous' },
});

const suzuki: ConversationTarget = { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' };
const sato: ConversationTarget = { type: 'department', id: 'dept-sales', label: '営業部' };
const blank: ConversationTarget = { type: 'staff', id: ' ', label: '鈴木' };
const noLabel: ConversationTarget = { type: 'staff', id: 'staff-x', label: '' };

describe('氏名の長さの上限 (ADR 0011 §3-e)', () => {
  it('上限は提案値 50（owner の確認待ち。値を変えるならこのテストも意図して変える）', () => {
    expect(VISITOR_NAME_MAX_LENGTH).toBe(50);
  });

  it('上限ちょうどは有効、1 文字超えると無効（境界のすぐ内側と外側）', () => {
    expect(isVisitorNameWithinLimit('あ'.repeat(VISITOR_NAME_MAX_LENGTH))).toBe(true);
    expect(isVisitorNameWithinLimit('あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('前後の空白は数えず、サロゲートペアは 1 文字と数える', () => {
    expect(isVisitorNameWithinLimit(`  ${'あ'.repeat(VISITOR_NAME_MAX_LENGTH)}  `)).toBe(true);
    expect(isVisitorNameWithinLimit('𠮷'.repeat(VISITOR_NAME_MAX_LENGTH))).toBe(true);
  });

  it('上限を超えた氏名は、高信頼でも復唱済みでも取得済みとみなさず聞き直す', () => {
    const tooLong = 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1);
    for (const certainty of ['confirmed', 'high'] as const) {
      const draft: ConversationDraft = {
        purpose: resolved<ReceptionPurposeId>('meeting', 'confirmed'),
        target: resolved(suzuki, 'confirmed'),
        visitorName: resolved(tooLong, certainty, 'voice'),
      };
      expect(nextConversationFocus(draft)).toEqual({ kind: 'collect', slot: 'visitorName' });
    }
  });
});

/*
 * owner の要求 (b): 無効な値が、後から来た有効な値を阻まない。
 *
 * 各 slot について「無効な値」と「有効な値」の宇宙を作り、全組合せで次を縛る。
 * - 結果は常に有効か、slot 無しのどちらか（無効値を draft に残さない）。
 * - 下界: current か incoming のどちらかが有効なら、結果は必ず有効（slot 無しにならない）。
 * - current が無効（または無し）で incoming が有効なら、結果は incoming。
 * - incoming が無効（または無し）なら、結果は current の正規化と同じ。
 */
type SlotCase<T> = { readonly slot: ConversationSlot<T> | undefined; readonly valid: boolean };

function checkMergeInvariant<K extends 'purpose' | 'target' | 'visitorName' | 'company'>(
  key: K,
  cases: ReadonlyArray<SlotCase<NonNullable<ConversationDraft[K]> extends ConversationSlot<infer T> ? T : never>>,
): number {
  let checked = 0;
  for (const c of cases) {
    for (const i of cases) {
      const current = (c.slot ? { [key]: c.slot } : {}) as ConversationDraft;
      const incoming = (i.slot ? { [key]: i.slot } : {}) as ConversationDraft;
      const merged = mergeConversationDraft(current, incoming)[key];
      checked += 1;

      // 結果は正規化済み（再正規化しても変わらない）。
      expect(normalizeConversationDraft({ [key]: merged } as ConversationDraft)[key]).toEqual(merged);

      if (c.valid || i.valid) expect(merged).toBeDefined();
      else expect(merged).toBeUndefined();

      if (!c.valid && i.valid) {
        expect(merged).toEqual(normalizeConversationDraft(incoming)[key]);
      }
      if (!i.valid) {
        expect(merged).toEqual(normalizeConversationDraft(current)[key]);
      }
      if (c.valid && i.valid) {
        expect([normalizeConversationDraft(current)[key], normalizeConversationDraft(incoming)[key]]).toContainEqual(
          merged,
        );
      }
    }
  }
  return checked;
}

describe('無効な値は後から来た有効な値を阻まない（owner 要求 b / 前回 MAJOR-3）', () => {
  it('visitorName: 空白・長すぎ・空候補の曖昧は、後の有効な氏名に置き換わる', () => {
    const long = 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1);
    const n = checkMergeInvariant('visitorName', [
      { slot: undefined, valid: false },
      { slot: resolved('  ', 'high', 'voice'), valid: false },
      { slot: resolved('  ', 'confirmed'), valid: false },
      { slot: resolved(long, 'confirmed'), valid: false },
      // 氏名の候補選択は出さない（復唱に出すのは 1 つだけ。ADR 0011 §6）。曖昧な氏名は聞き直す。
      { slot: ambiguous('張', '李'), valid: false },
      { slot: ambiguous(' '), valid: false },
      { slot: resolved('Taro', 'high', 'voice'), valid: true },
      { slot: resolved('張', 'confirmed', 'voice'), valid: true },
    ]);
    expect(n).toBe(64);
  });

  it('target: 空 ID・空ラベル・空候補だけの曖昧は、後の有効な target に置き換わる', () => {
    checkMergeInvariant('target', [
      { slot: undefined, valid: false },
      { slot: resolved(blank, 'confirmed'), valid: false },
      { slot: resolved(noLabel, 'high', 'voice'), valid: false },
      { slot: ambiguous(blank, noLabel), valid: false },
      { slot: ambiguous(suzuki, blank), valid: true },
      { slot: resolved(sato, 'high', 'voice'), valid: true },
      { slot: resolved(suzuki, 'confirmed'), valid: true },
    ]);
  });

  it('purpose: 一覧に無い ID（confirmed でも）と音声由来は、後の有効な目的を阻まない', () => {
    checkMergeInvariant('purpose', [
      { slot: undefined, valid: false },
      { slot: resolved('bogus' as ReceptionPurposeId, 'confirmed'), valid: false },
      { slot: ambiguous('bogus' as ReceptionPurposeId), valid: false },
      { slot: resolved<ReceptionPurposeId>('meeting', 'high', 'voice'), valid: false },
      { slot: ambiguous<ReceptionPurposeId>('meeting', 'other'), valid: false },
      { slot: resolved<ReceptionPurposeId>('delivery', 'confirmed', 'qr'), valid: true },
      { slot: resolved<ReceptionPurposeId>('meeting', 'confirmed'), valid: true },
    ]);
  });

  it('company: 空白と音声由来（音声から埋めない）は、後の有効な会社名を阻まない', () => {
    checkMergeInvariant('company', [
      { slot: undefined, valid: false },
      { slot: resolved('  ', 'confirmed'), valid: false },
      { slot: resolved('株式会社サンプル', 'high', 'voice'), valid: false },
      { slot: resolved('株式会社サンプル', 'confirmed', 'reservation'), valid: true },
      { slot: resolved('Example Inc.', 'confirmed'), valid: true },
    ]);
  });

  it('無効な purpose が confirmed で入っていても、同じ質問を繰り返さず有効な目的で前へ進む', () => {
    let draft: ConversationDraft = {
      purpose: resolved('bogus' as ReceptionPurposeId, 'confirmed'),
      target: resolved(suzuki, 'confirmed'),
      visitorName: resolved('張', 'confirmed', 'voice'),
    };
    expect(nextConversationFocus(draft)).toEqual({ kind: 'collect', slot: 'purpose' });
    draft = mergeConversationDraft(draft, { purpose: resolved<ReceptionPurposeId>('meeting', 'confirmed') });
    expect(nextConversationFocus(draft)).toEqual({ kind: 'finalConfirmation' });
  });

  it('曖昧な候補は有効なものだけを残す（来訪者に見せる候補と数が一致する）', () => {
    const normalized = normalizeConversationDraft({ target: ambiguous(suzuki, blank, sato, noLabel) });
    expect(normalized.target).toEqual(ambiguous(suzuki, sato));
  });
});
