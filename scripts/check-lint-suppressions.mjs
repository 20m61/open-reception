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

/**
 * 🔴 **`--no-inline-config` 下で `RULE` が報告される場所と件数**。ここが主検査である。
 *
 * `suppressedMessages`（通常実行）だけを見る版には**構造的な盲点**があった:
 * `/* eslint react-hooks/exhaustive-deps: "off" *\/` は**抑止を 1 つも作らない**。
 * severity を変えるので問題がそもそも報告されず、抑止の記録も残らない。件数も総数も
 * 理由判定も動かないまま、受付導線の任意のファイルで依存の取りこぼしを 1 行で無検査化できた
 * （実測）。`--no-inline-config` は inline 指示を**すべて**無効化するので、
 * disable ディレクティブとインライン severity 変更の **2 族がこの数へ現れる**
 * （増えれば上界、減れば下界で落ちる）。
 *
 * 🔴 **config 側の上書き・`ignores` はここに現れない。** `--no-inline-config` が無効化するのは
 * inline 指示だけで、config は生きたまま。新しいファイルへスコープした `'off'` や `ignores`
 * 追加は報告も抑止も発生させないので、この数は動かない。その族は
 * `tests/config/lint-warning-budget.test.ts` が `eslint.config.mjs` を import して縛る。
 */
const EXPECTED_RULE = new Map([
  ['src/components/kiosk/KioskFlow.tsx', 1],
  ['src/components/kiosk/checkout/CheckoutFlow.tsx', 1],
  ['src/components/kiosk/reception-screens.tsx', 1],
]);

/**
 * 全ルールの抑止（通常実行の `suppressedMessages`）を**ファイル別**に固定する。
 * 総数 1 つだと (a) 無関係な PR が 1 件増減しただけで main が赤くなり、
 * (b)「あるファイルで +k、別ファイルで −k」の相殺が通ってしまう。
 * ファイル別なら壊れる範囲が触ったファイルに局所化し、失敗も名指しできる。
 */
const EXPECTED_SUPPRESSIONS = new Map([
  ['src/components/admin/BrandingManager.tsx', 1],
  ['src/components/admin/ReservationsManager.tsx', 1],
  ['src/components/kiosk/KioskFlow.tsx', 1],
  ['src/components/kiosk/avatar/fallback-image.tsx', 1],
  ['src/components/kiosk/checkout/CheckoutFlow.tsx', 1],
  ['src/components/kiosk/reception-screens.tsx', 2],
  ['src/components/kiosk/signage/SignageDisplay.tsx', 1],
  ['src/components/kiosk/signage/SignageItemView.tsx', 2],
  ['src/lib/data/fake-dynamo.ts', 2],
  ['src/lib/data/index.ts', 1],
]);

const RULE = 'react-hooks/exhaustive-deps';


// 🔴 `npx` を使わない。eslint が未インストールだとレジストリ取得を試み、プロキシ環境では
// ハングか長い失敗になる。ローカル bin を直接叩き、無ければ理由を言って止まる。
const ESLINT = join(process.cwd(), 'node_modules', '.bin', 'eslint');
if (!existsSync(ESLINT)) {
  console.error('eslint が見つかりません: ' + ESLINT + '（npm ci を先に実行してください）');
  process.exit(2);
}

function eslintJson(extraArgs) {
  try {
    return JSON.parse(
      execFileSync(ESLINT, ['.', '-f', 'json', ...extraArgs], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // stderr は捨てない。落ちたときに理由がログから読めなくなる。
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    // eslint は問題を 1 件でも報告すると非 0 で終わる。例外の stdout に JSON が入る。
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('[')) {
      return JSON.parse(error.stdout);
    }
    console.error('eslint を JSON で実行できませんでした: ' + error.message);
    if (error.stderr) console.error(String(error.stderr).trim());
    process.exit(2);
  }
}

const results = eslintJson([]);
const bare = eslintJson(['--no-inline-config']);

const found = [];
const suppressionsByFile = new Map();
for (const file of results) {
  const rel = file.filePath.replace(process.cwd() + '/', '');
  for (const m of file.suppressedMessages ?? []) {
    suppressionsByFile.set(rel, (suppressionsByFile.get(rel) ?? 0) + 1);
    if (m.ruleId !== RULE) continue;
    const parts = (m.suppressions ?? []).map((x) => (x.justification ?? '').trim());
    // 🔴 **OR ではなく AND。** 「1 つでも理由があれば可」にすると、無差別 disable が持つ
    // 空の justification を捨ててしまい、重なった抑止を「理由あり」と誤判定する。
    const missingReason = parts.length === 0 || parts.some((j) => j === '');
    found.push({ file: rel, line: m.line, justification: parts.filter((j) => j !== '').join(' / '), missingReason });
  }
}

/** `--no-inline-config` 下で RULE が報告される場所（＝主検査の実測値）。 */
const ruleByFile = new Map();
for (const file of bare) {
  const rel = file.filePath.replace(process.cwd() + '/', '');
  for (const m of file.messages ?? []) {
    if (m.ruleId === RULE) ruleByFile.set(rel, (ruleByFile.get(rel) ?? 0) + 1);
  }
}

console.log(
  RULE + ' の抑止: ' + found.length + ' 件 / 全ルールの抑止: ' +
    [...suppressionsByFile.values()].reduce((a, b) => a + b, 0) + ' 件',
);
console.log('--no-inline-config 下の ' + RULE + ': ' + [...ruleByFile.values()].reduce((a, b) => a + b, 0) + ' 件');
for (const f of found) {
  console.log(
    '  ' + f.file + ':' + f.line + (f.missingReason ? '  【理由なし】' : '  -- ' + f.justification),
  );
}

const problems = [];

/** 期待 Map と実測 Map の**両側**一致（増えても減っても落ちる）。 */
function diff(label, expected, actual) {
  for (const [file, count] of expected) {
    const got = actual.get(file) ?? 0;
    if (got !== count) problems.push(label + ' ' + file + ': 期待 ' + count + ' 件 / 実際 ' + got + ' 件');
  }
  for (const [file, count] of actual) {
    if (!expected.has(file)) problems.push(label + ' ' + file + ': 期待していない場所に ' + count + ' 件');
  }
}

// 主検査。disable ディレクティブ・インライン severity 変更・config の後段上書きの 3 族が
// すべてこの数に現れる（増えれば上界、減れば下界）。
diff('[--no-inline-config]', EXPECTED_RULE, ruleByFile);
// 無差別 disable が RULE と重ならない場合も、そのファイルの抑止件数は必ず動く。
diff('[抑止]', EXPECTED_SUPPRESSIONS, suppressionsByFile);

// 🔴 **理由判定にも下界が要る。** 主検査を `--no-inline-config` 側へ移した結果、`found`
// （通常実行の抑止収集）は理由判定にしか使われなくなった。そのため収集そのものを壊す変異が
// 「理由の問題ゼロ」として素通りする（回帰行列で実測。生存 1/15）。収集件数も期待と縛る。
const expectedRuleTotal = [...EXPECTED_RULE.values()].reduce((a, b) => a + b, 0);
if (found.length !== expectedRuleTotal) {
  problems.push(
    RULE + ' の抑止収集: 期待 ' + expectedRuleTotal + ' 件 / 実際 ' + found.length +
      ' 件（理由判定が空振りしていないか）',
  );
}
for (const f of found) {
  if (f.missingReason) problems.push(f.file + ':' + f.line + ': 理由（-- 以降）が無い抑止が重なっている');
}

if (problems.length > 0) {
  console.error('\n抑止の棚卸しが期待と一致しません:');
  for (const p of problems) console.error('  ' + p);
  console.error('\n増減させるなら scripts/check-lint-suppressions.mjs の EXPECTED_RULE / EXPECTED_SUPPRESSIONS を直すこと。');
  console.error('理由の無い抑止は、error 化した意味を消すので許可しません。');
  process.exit(1);
}
console.log('抑止は期待どおり（件数・場所・理由）');
