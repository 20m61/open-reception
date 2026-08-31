#!/usr/bin/env node
/**
 * 抑止（eslint-disable 系）の棚卸しを **ESLint 自身に数えさせる** (#813)。
 *
 * ## なぜ自前で数えないか
 *
 * ここは 4 周にわたって「抑止の綴りを自前で探す」実装を直し続け、そのたびに独立レビューが
 * 別の書き方で素通りさせた:
 *
 *   1 綴りの固定文字列 → 行末形・ブロック形で突破
 *   3 綴りの正規表現   → ルール名省略・複数行ブロックで突破
 *   コメントの文法判定 → 理由の区切りが ESLint では 2 個以上のハイフンであること、
 *                        文字列リテラル中のブロックコメント開始記号が抽出を壊すこと、で突破
 *
 * 綴りを足す限り終わらない。**ESLint の文法を手写しすること自体が前提の誤り**だった。
 *
 * --no-inline-config は inline 指示を**すべて無効化**する。通常実行との差分は
 * 「その抑止が無ければ報告されていた問題」そのもので、ファイル・行・ruleId が ESLint の
 * 口から出る。綴り・複数行・ルール名省略・区切り記号・文字列リテラルのどれにも
 * 影響されない（構成上、文法と一致することが保証される）。
 *
 * ## 何を止めるか
 *
 * - react-hooks/exhaustive-deps の抑止が**既知の 3 ファイル以外**に増えること
 * - 無差別 disable（ルール名なし）が exhaustive-deps を巻き込んで隠すこと
 *   （ルール名を書いたか否かに関係なく、実際に隠していれば差分に出る）
 *
 * 何も隠していない抑止は差分に出ない。それは意図どおりで、**guard の目的は禁止ではなく
 * 「実際に効いている抑止をレビューに晒すこと」**である。
 */
import { execFileSync } from 'node:child_process';

/** 抑止を許している場所。増やすときはここを直す＝レビューに必ず目が入る。 */
const ALLOWED = new Set([
  'src/components/kiosk/KioskFlow.tsx',
  'src/components/kiosk/checkout/CheckoutFlow.tsx',
  'src/components/kiosk/reception-screens.tsx',
]);
const RULE = 'react-hooks/exhaustive-deps';

function run(extraArgs) {
  // 🔴 **非 0 終了でも stdout を読む。** eslint は問題を 1 件でも報告すると非 0 で終わるので、
  // --no-inline-config（抑止を全部外す）側はまず必ず非 0 になる。例外の stdout に JSON が入る。
  try {
    return JSON.parse(
      execFileSync('npx', ['eslint', '.', '-f', 'json', ...extraArgs], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('[')) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function problems(results) {
  const seen = new Map();
  for (const file of results) {
    const rel = file.filePath.replace(process.cwd() + '/', '');
    for (const m of file.messages) {
      seen.set(rel + ' ' + m.line + ' ' + (m.ruleId ?? '') + ' ' + m.message, {
        file: rel,
        line: m.line,
        ruleId: m.ruleId,
      });
    }
  }
  return seen;
}

let withConfig;
let withoutConfig;
try {
  withConfig = problems(run([]));
  withoutConfig = problems(run(['--no-inline-config']));
} catch (error) {
  console.error('eslint を JSON で実行できませんでした:', error.message);
  process.exit(2);
}

/** 抑止が実際に隠している問題（= inline 指示を切ったときだけ出るもの）。 */
const suppressed = [...withoutConfig.entries()]
  .filter(([key]) => !withConfig.has(key))
  .map(([, value]) => value);

const target = suppressed.filter((p) => p.ruleId === RULE);
const offenders = target.filter((p) => !ALLOWED.has(p.file));

console.log(
  '抑止が実際に隠している問題: ' + suppressed.length + ' 件（うち ' + RULE + ': ' + target.length + ' 件）',
);
for (const p of target) console.log('  ' + p.file + ':' + p.line + '  ' + p.ruleId);

if (offenders.length > 0) {
  console.error('\n許可されていない場所で ' + RULE + ' が抑止されています:');
  for (const p of offenders) console.error('  ' + p.file + ':' + p.line);
  console.error('\n抑止を増やすなら scripts/check-lint-suppressions.mjs の ALLOWED を直すこと。');
  console.error('理由の無い抑止・ルール名を書かない無差別 disable も、隠していればここに出ます。');
  process.exit(1);
}
console.log('抑止は許可された場所だけ');
