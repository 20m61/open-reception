/**
 * 担当者の読み（よみがな）の検証 (#1287)。
 *
 * 音声で担当者を名指ししたとき、同じ姓の担当者がいるかを表示名と読みから推定する（#1285）。
 * 読みの無い担当者が 1 人でもいる名簿では、担当者を自動で確定せず常に復唱する。
 * そのため管理画面の全経路（追加・編集・CSV 取り込み）で、読みを「姓と名を空白で区切った
 * かな」で登録するよう、同じ規則で検証する。
 *
 * 正規化は `./search.ts` の `normalize` と揃える（NFKC → trim → カタカナをひらがなへ）。
 * NFKC で半角カタカナは全角へ、全角空白は半角空白へ寄る。
 *
 * 型（`Staff.kana?: string`）は任意のまま変えない。旧レコードは読みが無くても読める。
 */

/** 読みの判定結果。`ok` 以外は「音声での自動確定が止まる」原因になる。 */
export type StaffKanaStatus = 'missing' | 'unseparated' | 'invalid' | 'ok';

/**
 * 読みの扱い。
 * - `required`   … 案 A: `ok` 以外は保存できない
 * - `encouraged` … 案 B: 保存はできるが、警告を出し一覧で目立たせる
 */
export type StaffKanaPolicy = 'required' | 'encouraged';

/**
 * 🔴 owner の選択（案 A / 案 B）はこの 1 行で切り替える。
 * draft の既定は非破壊の `encouraged`。
 */
export const STAFF_KANA_POLICY: StaffKanaPolicy = 'encouraged';

const WHITESPACE = /\s+/u;
/** ひらがな（ゔ・ゕ・ゖ を含む）・長音・踊り字・濁点/半濁点のみ。 */
const KANA_TOKEN = /^[ぁ-ゖゝゞー゛゜]+$/u;
/**
 * かなの文字（ぁ〜ゖ）を 1 つ以上含むか。長音符・踊り字・濁点だけの語は読みにならない
 * （音声の判定 `kiosk-bridge.ts` の `hasReading` と揃える。そちらは文字を含まない読みを「読みなし」とみなす）。
 */
const HAS_KANA_LETTER = /[ぁ-ゖ]/u;

/** 全角カタカナ → ひらがな（`search.ts` と同じ 0x60 シフト）。 */
function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶ]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** 読みを判定する。 */
export function assessStaffKana(kana: string | undefined): StaffKanaStatus {
  if (kana === undefined) return 'missing';
  const normalized = katakanaToHiragana(kana.normalize('NFKC').trim());
  if (normalized === '') return 'missing';
  const tokens = normalized.split(WHITESPACE);
  if (tokens.every((t) => KANA_TOKEN.test(t) && !HAS_KANA_LETTER.test(t))) return 'missing';
  if (!tokens.every((t) => KANA_TOKEN.test(t) && HAS_KANA_LETTER.test(t))) return 'invalid';
  return tokens.length >= 2 ? 'ok' : 'unseparated';
}

/** その判定結果を、方針の下で保存拒否にするか。 */
export function rejectsStaffKana(status: StaffKanaStatus, policy: StaffKanaPolicy = STAFF_KANA_POLICY): boolean {
  return policy === 'required' && status !== 'ok';
}

/** 管理画面・CSV 取り込みに出す案内文。`ok` は `null`。 */
export function kanaIssueMessage(status: StaffKanaStatus): string | null {
  switch (status) {
    case 'missing':
      return 'よみがなが未登録です。';
    case 'unseparated':
      return '姓と名のあいだを空白で区切ってください（例: さとう たろう）。';
    case 'invalid':
      return 'よみがなは、ひらがなかカタカナと空白だけで入力してください。';
    case 'ok':
      return null;
  }
}

/** 担当者一覧で行に付ける短い印。`ok` は `null`。 */
export function kanaFlagLabel(status: StaffKanaStatus): string | null {
  switch (status) {
    case 'missing':
      return 'よみがな未登録';
    case 'unseparated':
      return '姓と名の区切りなし';
    case 'invalid':
      return 'よみがなの形式違い';
    case 'ok':
      return null;
  }
}

export type StaffKanaSummary = { missing: number; unseparated: number; invalid: number };

/**
 * 有効な担当者の読みを判定ごとに数える。無効な担当者は音声の辞書に入らないので数えない（#1285 と同じ）。
 */
export function summarizeStaffKana(
  staff: ReadonlyArray<{ readonly kana?: string; readonly enabled: boolean }>,
): StaffKanaSummary {
  const summary: StaffKanaSummary = { missing: 0, unseparated: 0, invalid: 0 };
  for (const s of staff) {
    if (!s.enabled) continue;
    const status = assessStaffKana(s.kana);
    if (status !== 'ok') summary[status] += 1;
  }
  return summary;
}

/**
 * 読みが無い・区切られていない担当者がいるときの影響の説明（#1285）。
 * 読みが無い担当者が 1 人でもいると自動確定が止まる。区切りが無いと同じ姓の判定が粗くなる。
 */
export const KANA_VOICE_IMPACT_NOTE =
  'よみがなが無い担当者が 1 人でもいると、音声で担当者を選ぶときに自動で確定せず、毎回確認します。姓と名を空白で区切ると、同じ姓の担当者を正しく見分けられます。';
