/**
 * 担当者検索ロジック (issue #13, #322)。
 *
 * よみがな・別名・英字表記に加え、ローマ字入力・表記ゆれ（濁点/半濁点・長音・大文字小文字・
 * 全角半角・カタカナ/ひらがな）・1 文字程度の typo に寛容な検索を行う純関数群。
 * 無効化された担当者は除外する。
 *
 * ランキング方針（あいまい一致で無関係な候補が上位に来ないように、段階を分けて優先する）:
 *   1. exact    … 正規化後に完全一致
 *   2. prefix   … 正規化後に前方一致
 *   3. contains … 正規化後に部分一致（従来の挙動）
 *   4. fuzzy    … ローマ字→かな変換後の一致、または編集距離 1 以内の「もしかして」候補
 * 上位の tier が 1 件でもあれば、下位 tier だけの弱い一致で埋もれない（呼び出し側は tier 単位で
 * グルーピングし、fuzzy のみ「もしかして」として区別して表示できる）。
 */
import type { Staff } from './types';

/** 検索対象になりうる最小の形。KioskFlow の directory 型など、Staff 以外でも使えるようにする。 */
export type Searchable = {
  displayName: string;
  kana?: string;
  aliases: readonly string[];
};

export type MatchTier = 'exact' | 'prefix' | 'contains' | 'fuzzy';

const TIER_RANK: Record<MatchTier, number> = { exact: 0, prefix: 1, contains: 2, fuzzy: 3 };

export type ScoredMatch<T> = {
  item: T;
  tier: MatchTier;
};

const WHITESPACE = /[\s　]+/gu;

/** 全角カタカナ → ひらがな（表記ゆれ吸収。Unicode の 0x60 シフトで変換できる範囲のみ）。 */
function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶ]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** NFKC 正規化 + trim + lowercase + カタカナ→ひらがな統一。空白は残す（トークン分割に使うため）。 */
function normalize(value: string): string {
  return katakanaToHiragana(value.normalize('NFKC').trim().toLowerCase());
}

/** 空白を除去した比較用文字列（「さとう たろう」="さとうたろう"を同一視）。 */
function stripSpaces(value: string): string {
  return value.replace(WHITESPACE, '');
}

/**
 * ローマ字 → ひらがな 変換テーブル（自前実装。#105 回避のため外部依存を増やさない）。
 * `romajiToHiragana` 側で 3→2→1 文字の順に貪欲マッチする。
 */
const ROMAJI_TABLE: Record<string, string> = {
  // 拗音（3 文字）
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
  gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  sha: 'しゃ', shu: 'しゅ', sho: 'しょ',
  sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ',
  jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ',
  tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
  nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  // 2 文字
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ', shi: 'し',
  za: 'ざ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ', ji: 'じ',
  ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と', chi: 'ち', tsu: 'つ',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', he: 'へ', ho: 'ほ', fu: 'ふ',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  wa: 'わ', wo: 'を',
  nn: 'ん',
  // 1 文字
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  n: 'ん',
};

const ROMAJI_CONSONANTS = new Set('kgsztdnhbpmyrw'.split(''));

/**
 * ローマ字（アルファベット）の連続部分だけをひらがなへ変換する。
 * かな・漢字などアルファベットでない文字はそのまま通す（既に日本語の入力を壊さない）。
 * 促音（子音の連続, 例: kekkon → けっこん）は簡易的に扱う（完全なかな漢字変換ではなく、
 * 検索候補生成のための軽量変換）。
 */
export function romajiToHiragana(input: string): string {
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < lower.length) {
    const ch = lower.charAt(i);
    if (!/[a-z]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    // 促音: 同じ子音が連続する場合（nn は撥音なので除外）。
    if (
      ROMAJI_CONSONANTS.has(ch) &&
      ch !== 'n' &&
      lower.charAt(i + 1) === ch &&
      i + 2 < lower.length &&
      /[a-z]/.test(lower.charAt(i + 2))
    ) {
      out += 'っ';
      i += 1;
      continue;
    }
    const three = lower.slice(i, i + 3);
    const two = lower.slice(i, i + 2);
    const one = lower.slice(i, i + 1);
    if (ROMAJI_TABLE[three]) {
      out += ROMAJI_TABLE[three];
      i += 3;
    } else if (ROMAJI_TABLE[two]) {
      out += ROMAJI_TABLE[two];
      i += 2;
    } else if (ROMAJI_TABLE[one]) {
      out += ROMAJI_TABLE[one];
      i += 1;
    } else {
      // 未知の綴りは 1 文字捨てて進む（例外を投げず、できる範囲だけ変換する）。
      i += 1;
    }
  }
  return out;
}

/** レーベンシュタイン距離（編集距離）。1 文字 typo 許容の判定に使う。 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;
  let prev: number[] = [];
  let curr: number[] = [];
  for (let j = 0; j <= blen; j += 1) prev.push(j);
  for (let i = 1; i <= alen; i += 1) {
    curr = [i];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= blen; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (curr[j - 1] ?? 0) + 1;
      const substitution = (prev[j - 1] ?? 0) + cost;
      curr.push(Math.min(deletion, insertion, substitution));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[blen] ?? Math.max(alen, blen);
}

/** クエリの正規化バリアント（元の表記 + ローマ字→かな変換）。空白除去済み。 */
function queryVariants(query: string): string[] {
  const base = normalize(query);
  const romaji = katakanaToHiragana(romajiToHiragana(base));
  const variants = new Set([stripSpaces(base), stripSpaces(romaji)]);
  variants.delete('');
  return [...variants];
}

/** フィールドの比較候補（トークン分割 + 空白除去した全体）。空白除去済み。 */
function fieldVariants(value: string): string[] {
  const n = normalize(value);
  const tokens = n.split(WHITESPACE).filter((t) => t !== '');
  const variants = new Set([stripSpaces(n), ...tokens]);
  variants.delete('');
  return [...variants];
}

/** 1 フィールド分の候補群から、クエリに対する最良の一致 tier を返す（無ければ null）。 */
function bestTier(queries: readonly string[], fields: readonly string[]): MatchTier | null {
  let best: MatchTier | null = null;
  for (const f of fields) {
    for (const q of queries) {
      let tier: MatchTier | null = null;
      if (f === q) {
        tier = 'exact';
      } else if (f.startsWith(q)) {
        tier = 'prefix';
      } else if (f.includes(q)) {
        tier = 'contains';
      } else if (q.length >= 2 && Math.abs(f.length - q.length) <= 1 && levenshteinDistance(f, q) <= 1) {
        // 1 文字の typo・濁点半濁点・長音のゆれはここで吸収する（もしかして候補）。
        tier = 'fuzzy';
      }
      if (tier && (best === null || TIER_RANK[tier] < TIER_RANK[best])) {
        best = tier;
        if (best === 'exact') return best; // これ以上は上がらないので打ち切る
      }
    }
  }
  return best;
}

/**
 * クエリに一致する項目を tier 付きでスコアリングして返す（exact/prefix/contains/fuzzy の順）。
 * 同一 tier 内は入力の並び順を保つ（安定ソート）。空クエリは呼び出し側で別途処理すること。
 */
export function searchStaffScored<T extends Searchable>(
  items: ReadonlyArray<T>,
  query: string,
): ScoredMatch<T>[] {
  const queries = queryVariants(query);
  if (queries.length === 0) return [];
  const scored: ScoredMatch<T>[] = [];
  for (const item of items) {
    const fields = [
      ...fieldVariants(item.displayName),
      ...fieldVariants(item.kana ?? ''),
      ...item.aliases.flatMap((a) => fieldVariants(a)),
    ];
    const tier = bestTier(queries, fields);
    if (tier) scored.push({ item, tier });
  }
  return scored.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

/**
 * クエリに一致する有効な担当者を返す（tier 順。exact/prefix/contains が fuzzy より上位）。
 * 空クエリの場合は有効な担当者を全件返す。
 */
export function searchStaff(staff: ReadonlyArray<Staff>, query: string): Staff[] {
  const enabled = staff.filter((s) => s.enabled);
  if (normalize(query) === '') {
    return [...enabled];
  }
  return searchStaffScored(enabled, query).map((m) => m.item);
}
