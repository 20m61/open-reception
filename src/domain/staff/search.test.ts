import { describe, expect, it } from 'vitest';
import { levenshteinDistance, romajiToHiragana, searchStaff, searchStaffScored } from './search';
import { MOCK_STAFF } from './mock-data';
import type { Staff } from './types';

/** テスト用の最小 Staff フィクスチャを作る（callTargets 等は呼び出し確定に無関係なので固定値）。 */
function staff(overrides: Partial<Staff> & Pick<Staff, 'id' | 'displayName'>): Staff {
  return {
    kana: undefined,
    aliases: [],
    departmentId: 'dept-x',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
    ...overrides,
  };
}

describe('searchStaff', () => {
  it('表示名で検索できる', () => {
    const result = searchStaff(MOCK_STAFF, '佐藤');
    expect(result.map((s) => s.id)).toContain('staff-sato');
  });

  it('よみがなで検索できる', () => {
    const result = searchStaff(MOCK_STAFF, 'すずき');
    expect(result.map((s) => s.id)).toContain('staff-suzuki');
  });

  it('英字エイリアスで大文字小文字を無視して検索できる', () => {
    const result = searchStaff(MOCK_STAFF, 'tanaka');
    expect(result.map((s) => s.id)).toContain('staff-tanaka');
  });

  it('無効化された担当者は結果に含めない', () => {
    const result = searchStaff(MOCK_STAFF, '山田');
    expect(result).toHaveLength(0);
  });

  it('空クエリでは有効な担当者を全件返す', () => {
    const result = searchStaff(MOCK_STAFF, '   ');
    expect(result.every((s) => s.enabled)).toBe(true);
    expect(result).toHaveLength(MOCK_STAFF.filter((s) => s.enabled).length);
  });

  it('未ヒット時は空配列を返す（呼び出し側で代替導線を出す）', () => {
    expect(searchStaff(MOCK_STAFF, 'いない人')).toHaveLength(0);
  });
});

describe('romajiToHiragana (#322)', () => {
  const cases: Array<[string, string]> = [
    ['sato', 'さと'],
    ['satou', 'さとう'],
    ['suzuki', 'すずき'],
    ['tanaka', 'たなか'],
    ['takahashi', 'たかはし'],
    ['watanabe', 'わたなべ'],
    ['kekkon', 'けっこん'], // 促音
    ['kyouto', 'きょうと'], // 拗音 + 長音
    ['tokyo', 'ときょ'],
  ];

  it.each(cases)('%s → %s', (input, expected) => {
    expect(romajiToHiragana(input)).toBe(expected);
  });

  it('かな・漢字はそのまま通す（既存の日本語入力を壊さない）', () => {
    expect(romajiToHiragana('さとう')).toBe('さとう');
    expect(romajiToHiragana('佐藤')).toBe('佐藤');
  });
});

describe('levenshteinDistance', () => {
  it('同一文字列は距離 0', () => {
    expect(levenshteinDistance('たかはし', 'たかはし')).toBe(0);
  });

  it('1 文字置換は距離 1', () => {
    expect(levenshteinDistance('たかはし', 'たかばし')).toBe(1);
  });

  it('1 文字挿入/削除は距離 1', () => {
    expect(levenshteinDistance('おおの', 'おうの')).toBe(1);
    expect(levenshteinDistance('おおの', 'おの')).toBe(1);
  });
});

/**
 * AC1: ローマ字・表記ゆれ・1 文字 typo で従来 0 件だったクエリが候補を返す (table-driven)。
 * `MOCK_STAFF` の既存データ（エイリアス未登録の項目も含む）に対して検証する。
 */
describe('searchStaff: 寛容化 (#322 AC1) — 従来 0 件だったクエリが候補を返す', () => {
  const cases: Array<{ label: string; query: string; expectId: string }> = [
    { label: 'ローマ字（完全一致、末尾の長音まで変換）: satou → 佐藤（さとう）', query: 'satou', expectId: 'staff-sato' },
    { label: '濁点ゆれ: すすき → 鈴木（すずき）', query: 'すすき', expectId: 'staff-suzuki' },
    { label: '長音ゆれ: おうの → 大野（おおの）', query: 'おうの', expectId: 'staff-ono' },
    { label: '1 文字 typo: たかばし → 高橋（たかはし）', query: 'たかばし', expectId: 'staff-takahashi' },
    { label: 'カタカナ表記ゆれ: タナカ → 田中（たなか）', query: 'タナカ', expectId: 'staff-tanaka' },
  ];

  it.each(cases)('$label', ({ query, expectId }) => {
    // 旧仕様（正規化済み部分一致のみ）では 0 件だったことの証跡として、まず contains 一致しないことを確認する。
    const naiveNormalize = (v: string) => v.normalize('NFKC').trim().toLowerCase();
    const target = MOCK_STAFF.find((s) => s.id === expectId)!;
    const naiveHaystack = [target.displayName, target.kana ?? '', ...target.aliases].map(naiveNormalize);
    expect(naiveHaystack.some((h) => h.includes(naiveNormalize(query)))).toBe(false);

    const result = searchStaff(MOCK_STAFF, query);
    expect(result.map((s) => s.id)).toContain(expectId);
  });

  it('エイリアス未登録でもローマ字入力で見つかる（alias 依存を解消）', () => {
    const noAliasStaff: Staff[] = [
      staff({ id: 'staff-watanabe', displayName: '渡辺 一郎', kana: 'わたなべ いちろう', aliases: [] }),
    ];
    expect(searchStaff(noAliasStaff, 'watanabe').map((s) => s.id)).toContain('staff-watanabe');
    // 全角英字（NFKC で半角化されるだけでは日本語のかな/漢字と一致しないため、ローマ字変換が要る）。
    expect(searchStaff(noAliasStaff, 'ｗａｔａｎａｂｅ').map((s) => s.id)).toContain('staff-watanabe');
  });
});

/**
 * AC2: 誤ヒットで無関係な候補が上位に来ない（スコア順の検証）。
 * 同一クエリで exact/prefix/fuzzy が同時に発生するフィクスチャを用意し、順序と tier を検証する。
 */
describe('searchStaffScored: ランキング (#322 AC2)', () => {
  const fixture: Staff[] = [
    staff({ id: 'exact', displayName: '田中 花子', kana: 'たなか はなこ', aliases: [] }),
    staff({ id: 'prefix', displayName: '田中辺 三郎', kana: 'たなかべ さぶろう', aliases: [] }),
    staff({ id: 'fuzzy', displayName: '田中似 太郎', kana: 'たなが たろう', aliases: [] }),
    staff({ id: 'unrelated', displayName: '鈴木 一郎', kana: 'すずき いちろう', aliases: [] }),
  ];

  it('exact → prefix → fuzzy の順に並び、無関係な候補は結果に含まれない', () => {
    const scored = searchStaffScored(fixture, 'たなか');
    expect(scored.map((m) => m.item.id)).toEqual(['exact', 'prefix', 'fuzzy']);
    expect(scored.map((m) => m.tier)).toEqual(['exact', 'prefix', 'fuzzy']);
    // 無関係候補（鈴木）は上位はおろか結果自体に現れない。
    expect(scored.map((m) => m.item.id)).not.toContain('unrelated');
  });

  it('searchStaff は同じ順序を保つ', () => {
    const result = searchStaff(fixture, 'たなか');
    expect(result.map((s) => s.id)).toEqual(['exact', 'prefix', 'fuzzy']);
  });

  it('完全一致がある場合、無関係な部分一致より必ず上位に来る', () => {
    const scored = searchStaffScored(MOCK_STAFF, 'たなか');
    expect(scored[0]?.item.id).toBe('staff-tanaka');
    expect(scored[0]?.tier).toBe('exact');
  });
});

/**
 * AC4: 検索性能が数百人規模で劣化しないこと（厳密ベンチではなく、O(n) を維持できているかの目安）。
 */
describe('searchStaff: 性能 (#322 AC4)', () => {
  function buildLargeDirectory(count: number): Staff[] {
    const surnames = ['佐藤', '鈴木', '高橋', '田中', '渡辺', '伊藤', '山本', '中村', '小林', '加藤'];
    const kanaSurnames = ['さとう', 'すずき', 'たかはし', 'たなか', 'わたなべ', 'いとう', 'やまもと', 'なかむら', 'こばやし', 'かとう'];
    const result: Staff[] = [];
    for (let i = 0; i < count; i += 1) {
      const idx = i % surnames.length;
      result.push(
        staff({
          id: `bulk-${i}`,
          displayName: `${surnames[idx]} ${i}号`,
          kana: `${kanaSurnames[idx]} ${i}ごう`,
          aliases: [`Staff${i}`],
        }),
      );
    }
    return result;
  }

  it('500 人規模でも実用的な時間で完了し、結果は正しい', () => {
    const directory = buildLargeDirectory(500);
    const queries = ['たなか', 'tanaka', 'たかばし', 'すすき', 'いない人'];

    const start = performance.now();
    for (const q of queries) {
      searchStaff(directory, q);
    }
    const elapsedMs = performance.now() - start;

    // 5 クエリ x 500 件。O(n) 相当の軽量処理であれば数百 ms もかからない想定。
    // 端末差を考慮し十分な余裕を持たせつつ、O(n^2) 的な劣化があれば確実に超える閾値にする。
    expect(elapsedMs).toBeLessThan(1000);

    // 正しさも同時に確認する（時間だけ速くて壊れていては意味がない）。
    const hit = searchStaff(directory, 'たなか');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((s) => s.kana?.startsWith('たなか'))).toBe(true);
  });
});
