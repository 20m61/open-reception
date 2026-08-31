#!/usr/bin/env node
/**
 * 抑止（eslint-disable 系）の棚卸しを **ESLint 自身に数えさせる** (#813)。
 *
 * ## なぜ自前で数えないか
 *
 * ここは 4 周にわたって「抑止の綴りを自前で探す」実装を直し続け、そのたびに独立レビューが
 * 別の書き方で素通りさせた（固定文字列 → 3 綴りの正規表現 → コメントの文法判定）。
 * 最後は「理由の区切りは ESLint ではハイフン 2 個以上」「文字列リテラル中のブロックコメント
 * 開始記号が抽出を壊す」で破られた。**ESLint の文法を手写しすること自体が前提の誤り**だった。
 *
 * ESLint は通常実行の JSON で `suppressedMessages` を返し、各抑止の `justification`
 * （`--` 以降の理由）まで解析済みで持っている。これを読めば、綴り・複数行・ルール名省略・
 * 区切り記号・文字列リテラルのどれにも影響されない（構成上、文法と一致することが保証される）。
 *
 * ## 何を主張するか（**両側**）
 *
 * 🔴 **片側だけの主張にしない。** 以前の版は「許可されていない場所に無いこと」だけを見ており、
 * (a) 許可ファイルの中なら理由なしの抑止をいくらでも足せ、(b) 棚卸しが 0 件へ潰れても緑、
 * という 2 つの穴があった（どちらも実測でバイパス成立）。`CLAUDE.md`「検証の作法」の
 * 「不変条件は片側しか主張しない。下界を併せて縛る」に当たる。
 *
 * いまは **期待集合との一致**を主張する:
 *
 *  - ファイルごとの抑止件数が `EXPECTED` と**完全一致**（増えても減っても落ちる＝下界も縛る）
 *  - すべての抑止に**理由（justification）がある**
 *
 * ファイル粒度ではなく件数まで見るので、「許可ファイルの中で 2 件目を足す」も止まる。
 * 行番号で縛らないのは、無関係な編集で行がずれるたびに偽の赤を出さないため。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 抑止を許している場所と件数。増やすときはここを直す＝レビューに必ず目が入る。 */
const EXPECTED = new Map([
  ['src/components/kiosk/KioskFlow.tsx', 1],
  ['src/components/kiosk/checkout/CheckoutFlow.tsx', 1],
  ['src/components/kiosk/reception-screens.tsx', 1],
]);
const RULE = 'react-hooks/exhaustive-deps';
/**
 * 全ルールの抑止総数。追跡ルールと**重ならない**無差別 disable を捕まえるための下界。
 * 現在の内訳: exhaustive-deps 3（いずれも理由あり）+ 他ルール 10（no-img-element 7 /
 * no-explicit-any 2 / no-require-imports 1。いずれも理由なしだが既存として許容）。
 */
const EXPECTED_TOTAL = 13;

// 🔴 `npx` を使わない。eslint が未インストールだとレジストリ取得を試み、プロキシ環境では
// ハングか長い失敗になる。ローカル bin を直接叩き、無ければ理由を言って止まる。
const ESLINT = join(process.cwd(), 'node_modules', '.bin', 'eslint');
if (!existsSync(ESLINT)) {
  console.error('eslint が見つかりません: ' + ESLINT + '（npm ci を先に実行してください）');
  process.exit(2);
}

let results;
try {
  results = JSON.parse(
    execFileSync(ESLINT, ['.', '-f', 'json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // stderr は捨てない。落ちたときに理由がログから読めなくなる。
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('[')) {
    results = JSON.parse(error.stdout);
  } else {
    console.error('eslint を JSON で実行できませんでした: ' + error.message);
    if (error.stderr) console.error(String(error.stderr).trim());
    process.exit(2);
  }
}

const found = [];
let totalSuppressed = 0;
for (const file of results) {
  const rel = file.filePath.replace(process.cwd() + '/', '');
  for (const m of file.suppressedMessages ?? []) {
    totalSuppressed += 1;
    if (m.ruleId !== RULE) continue;
    const parts = (m.suppressions ?? []).map((x) => (x.justification ?? '').trim());
    // 🔴 **OR ではなく AND。** 「1 つでも理由があれば可」にすると、無差別 disable が持つ
    // 空の justification を捨ててしまい、重なった抑止を「理由あり」と誤判定する。
    // 無差別 disable は必ず空の justification を持つので、AND なら重なった瞬間に落ちる。
    const missingReason = parts.length === 0 || parts.some((j) => j === '');
    found.push({ file: rel, line: m.line, justification: parts.filter((j) => j !== '').join(' / '), missingReason });
  }
}

const actual = new Map();
for (const f of found) actual.set(f.file, (actual.get(f.file) ?? 0) + 1);

console.log(RULE + ' の抑止: ' + found.length + ' 件 / 全ルールの抑止: ' + totalSuppressed + ' 件');
for (const f of found) {
  console.log(
    '  ' + f.file + ':' + f.line + (f.missingReason ? '  【理由なし】' : '  -- ' + f.justification),
  );
}

const problems = [];
for (const [file, count] of EXPECTED) {
  const got = actual.get(file) ?? 0;
  if (got !== count) problems.push(file + ': 期待 ' + count + ' 件 / 実際 ' + got + ' 件');
}
for (const [file, count] of actual) {
  if (!EXPECTED.has(file)) problems.push(file + ': 許可されていない場所に ' + count + ' 件');
}
for (const f of found) {
  if (f.missingReason) problems.push(f.file + ':' + f.line + ': 理由（-- 以降）が無い抑止が重なっている');
}
// 🔴 **追跡ルールと重ならない無差別 disable は、件数でしか見えない。**
// `suppressedMessages` は「どのルール名を書いたか」を返さないので、
// `/* eslint-disable */` を 1 行置いてファイル全体を無検査にする変異は、
// 追跡ルールに重ならなければ上の検査を素通りする（実測で受付フロー本体が全ルール無検査になった）。
// 総数を期待値に入れると、どのファイルの無差別 disable も必ずここを動かす。
if (totalSuppressed !== EXPECTED_TOTAL) {
  problems.push(
    '全ルールの抑止総数: 期待 ' + EXPECTED_TOTAL + ' 件 / 実際 ' + totalSuppressed +
      ' 件（無差別 eslint-disable がファイル全体を無検査にしていないか）',
  );
}

if (problems.length > 0) {
  console.error('\n抑止の棚卸しが期待と一致しません:');
  for (const p of problems) console.error('  ' + p);
  console.error('\n増減させるなら scripts/check-lint-suppressions.mjs の EXPECTED を直すこと。');
  console.error('理由の無い抑止は、error 化した意味を消すので許可しません。');
  process.exit(1);
}
console.log('抑止は期待どおり（件数・場所・理由）');
