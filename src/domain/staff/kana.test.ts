import { describe, expect, it } from 'vitest';
import {
  STAFF_KANA_POLICY,
  assessStaffKana,
  kanaFlagLabel,
  kanaIssueMessage,
  rejectsStaffKana,
  summarizeStaffKana,
  type StaffKanaStatus,
} from './kana';

describe('assessStaffKana (#1287)', () => {
  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['   ', 'missing'],
    ['　', 'missing'],
  ] as const)('読みが無い %j は missing', (input, expected) => {
    expect(assessStaffKana(input)).toBe(expected);
  });

  // 音声の判定（#1285 の hasReading）と同じく、かなの文字を含まない語（長音符・踊り字・濁点だけ）は読みにならない。
  it.each(['ー', 'ー ー', 'ゝゞ', 'ーー　ゝ'])('かなの文字を含まない %j は missing', (input) => {
    expect(assessStaffKana(input)).toBe('missing');
  });

  // 「゛゜」は NFKC で結合文字へ変わるので、かなの語として扱わない（invalid）。
  it.each(['さとう ー', 'ー たろう', '゛゜'])('かなの文字を含まない語がある %j は invalid', (input) => {
    expect(assessStaffKana(input)).toBe('invalid');
  });

  it.each(['さとうたろう', 'サトウタロウ', 'さとう', 'ｻﾄｳﾀﾛｳ'])('区切りの無い %j は unseparated', (input) => {
    expect(assessStaffKana(input)).toBe('unseparated');
  });

  it.each(['佐藤 太郎', 'sato taro', 'さとう 太郎', 'さとう・たろう', 'さとう1 たろう', 'さとう たろう!'])(
    'かな以外を含む %j は invalid',
    (input) => {
      expect(assessStaffKana(input)).toBe('invalid');
    },
  );

  // 下界: 正しい読みは必ず ok（全部を判定不能にすれば「警告が出る」は空虚に満たせる）。
  it.each([
    'さとう たろう',
    'サトウ タロウ',
    'さとう　たろう', // 全角空白
    'ｻﾄｳ ﾀﾛｳ', // 半角カタカナ
    '  さとう   たろう  ', // 前後・連続の空白
    'ぐえん ゔぁん あん', // 3 語以上
    'グエン ヴァン アン',
    'こーへい たなか', // 長音
    'すずき いちろう',
    'ひがしやま はなこ',
  ])('正しい読み %j は ok', (input) => {
    expect(assessStaffKana(input)).toBe('ok');
  });
});

describe('rejectsStaffKana (#1287)', () => {
  const statuses: StaffKanaStatus[] = ['missing', 'unseparated', 'invalid', 'ok'];

  it("'required' は ok 以外をすべて拒否する", () => {
    expect(statuses.filter((s) => rejectsStaffKana(s, 'required'))).toEqual(['missing', 'unseparated', 'invalid']);
  });

  it("'encouraged' は何も拒否しない（保存はできる）", () => {
    expect(statuses.filter((s) => rejectsStaffKana(s, 'encouraged'))).toEqual([]);
  });
});

describe('kanaIssueMessage (#1287)', () => {
  it('ok には案内を出さない', () => {
    expect(kanaIssueMessage('ok')).toBeNull();
  });

  it.each(['missing', 'unseparated', 'invalid'] as const)('%s には日本語の案内を出す', (status) => {
    const message = kanaIssueMessage(status);
    expect(message).not.toBeNull();
    expect(message).toMatch(/[ぁ-ん]/u);
  });

  it('区切りの案内には例を含める', () => {
    expect(kanaIssueMessage('unseparated')).toContain('さとう たろう');
  });
});

describe('STAFF_KANA_POLICY (#1287)', () => {
  it('draft の既定は非破壊の encouraged（owner が A を選んだら required へ 1 行で替える）', () => {
    expect(STAFF_KANA_POLICY).toBe('encouraged');
  });
});

describe('kanaFlagLabel (#1287)', () => {
  it('ok には印を付けない', () => {
    expect(kanaFlagLabel('ok')).toBeNull();
  });

  it.each(['missing', 'unseparated', 'invalid'] as const)('%s には短い印を付ける', (status) => {
    const label = kanaFlagLabel(status);
    expect(label).not.toBeNull();
    expect((label ?? '').length).toBeLessThanOrEqual(12);
  });
});

describe('summarizeStaffKana (#1287)', () => {
  const s = (kana: string | undefined, enabled = true) => ({ kana, enabled });

  it('有効な担当者だけを数え、判定ごとに分ける', () => {
    expect(
      summarizeStaffKana([
        s(undefined),
        s(''),
        s('さとうたろう'),
        s('佐藤 太郎'),
        s('さとう たろう'),
        s(undefined, false), // 無効な担当者は音声の辞書に入らない
      ]),
    ).toEqual({ missing: 2, unseparated: 1, invalid: 1 });
  });

  // 下界: 全員が正しい読みなら全部 0（警告を出さない）。
  it('全員が正しい読みなら 0 件', () => {
    expect(summarizeStaffKana([s('さとう たろう'), s('スズキ ハナコ')])).toEqual({
      missing: 0,
      unseparated: 0,
      invalid: 0,
    });
  });
});
