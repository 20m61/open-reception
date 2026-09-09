import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchArguments, fetchSites, stripComments } from '../../src/domain/governance/fetch-failure-scan';

/**
 * 退館フローの `fetch` が**すべて、正しい締切を**渡す (#1029)。
 *
 * ## なぜ e2e ではなくここで縛るのか
 *
 * 🔴 **独立レビュー 1 周目 MAJOR-2 の実測**: 退館確定の `signal` を **credential 枝から
 * だけ**外す変異が、**unit 57 本・e2e 23 本を素通り**した。`checkout-confirm-yes` を
 * 押す spec は 2 本あるがどちらも**在館一覧経由**（`pending.kind === 'stay'`）なので、
 * QR / 退館コードで退館する経路（設計上の**主経路**。在館一覧は staff 補助）の確定は
 * スイート全体で一度も踏まれていない。**この経路は台帳が唯一のオラクルである。**
 *
 * #968 が platform で同じ族を踏み、同じ結論に達している ――
 * **配線の実在**を静的に、**帰結**を e2e で見る。
 *
 * ## 🔴 2 周目で「在るか」だけでは足りないと分かった
 *
 * 1 周目の台帳は「締切が在るか」しか見ていなかったので、**確定の締切を読み取り用の
 * 15 秒へ差し替える変異が unit 961 本・e2e 5 本を全部素通り**した（2 周目 MAJOR-2）。
 * 15 秒はサーバの予算（`serverTimeoutSec` = 30 秒）より短いので、**サーバ側では成功して
 * いるのに**来訪者へ「退館できたか確認できませんでした」と出る ―― `logic.ts` の doc が
 * 「絶対に避ける」と書いている状態そのものである。
 *
 * よって**どの経路にどの締切か**まで縛る。値の下界（`logic.test.ts`）だけでは、
 * 定数の**使われ方**は縛れない。
 */

const ROOT = join(import.meta.dirname, '..', '..');
const CHECKOUT_DIR = 'src/components/kiosk/checkout';

/**
 * 母集団は**ディレクトリを歩いて**作る (2 周目 MINOR-2)。
 *
 * 🔴 正本にした `tests/config/platform-fetch-failure.test.ts` は「隣のディレクトリの
 * helper へ移すだけで母集団から外れる」「`.tsx` だけを見ると hook へ切り出すだけで
 * 1 バイトも読まれなくなる」を**どちらも実測で生存させた**うえで塞いでいる。
 * 単一ファイルのハードコードはその逃げ道を再び開ける。
 */
function checkoutSources(): { rel: string; source: string }[] {
  return readdirSync(join(ROOT, CHECKOUT_DIR))
    .filter((n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'))
    .map((n) => ({
      rel: `${CHECKOUT_DIR}/${n}`,
      source: stripComments(readFileSync(join(ROOT, CHECKOUT_DIR, n), 'utf8')),
    }));
}

const READ = 'CHECKOUT_READ_TIMEOUT_MS';
const CONFIRM = 'CHECKOUT_CONFIRM_TIMEOUT_MS';

/**
 * この `fetch` が使うべき締切。
 *
 * - `/confirm` … 退館を確定する書き込み
 * - `/resolve` … 自己特定。POST だが退館は確定しないので読み取り扱い
 * - `/api/kiosk/checkout` へ POST … 在館一覧から選んだ退館の確定
 * - それ以外（GET） … 在館一覧の読み取り
 */
function expectedDeadline(args: string): string {
  if (args.includes('/checkout/confirm')) return CONFIRM;
  if (args.includes('/checkout/resolve')) return READ;
  return /method\s*:\s*'POST'/.test(args) ? CONFIRM : READ;
}

/**
 * `const x = AbortSignal.timeout(<constant>)` で**一意に**束縛された名前。
 *
 * 🔴 **束縛が 1 つだけであることまで見る** (2 周目 MINOR-1)。名前一致だけにすると、
 * 内側スコープで `const deadline = new AbortController().signal;` と**影付け**する変異が
 * 素通りした（実測。credential 枝では e2e も落とせないので検出手段が無くなる）。
 * 同名の束縛が 2 つ以上あるなら、どちらが渡っているか静的には決まらない ―― 通さない。
 */
function uniqueDeadlineNames(source: string, constant: string): string[] {
  const bound = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)].map((m) => m[1] as string);
  const fromTimeout = [
    ...source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*AbortSignal\\.timeout\\(${constant}\\)`, 'g')),
  ].map((m) => m[1] as string);
  return fromTimeout.filter((n) => bound.filter((b) => b === n).length === 1);
}

/**
 * `let x: AbortSignal | undefined;` ＋ `try { x = AbortSignal.timeout(<constant>); }` の形。
 *
 * 締切の生成を `try` の中へ入れる（2 周目 MINOR-3）と `const` では書けないので、
 * 代入の形も締切として認める。**代入も 1 箇所だけ**であることを要求する。
 */
function uniqueAssignedDeadlineNames(source: string, constant: string): string[] {
  const assigned = [...source.matchAll(/^\s*(\w+)\s*=\s*AbortSignal\.timeout\((\w+)\)/gm)];
  const names = assigned.filter((m) => m[2] === constant).map((m) => m[1] as string);
  return names.filter((n) => {
    const allAssign = [...source.matchAll(new RegExp(`^\\s*${n}\\s*=`, 'gm'))].length;
    const allBind = [...source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`, 'g'))].length;
    return allAssign === 1 && allBind === 1;
  });
}

/** この `fetch` 引数が、期待する締切を渡しているか。 */
function passesExpectedDeadline(args: string, source: string, constant: string): boolean {
  if (args.includes(`AbortSignal.timeout(${constant})`)) return true;
  const names = [
    ...uniqueDeadlineNames(source, constant),
    ...uniqueAssignedDeadlineNames(source, constant),
  ];
  return names.some((n) => new RegExp(`signal\\s*:\\s*${n}\\b`).test(args));
}

describe('退館フローの締切 (#1029)', () => {
  it('退館フローの fetch はすべて、その経路にふさわしい締切を渡す', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { rel, source } of checkoutSources()) {
      for (const site of fetchSites(source)) {
        checked += 1;
        const args = fetchArguments(source, site);
        const constant = expectedDeadline(args);
        if (!passesExpectedDeadline(args, source, constant)) {
          offenders.push(`${rel}@${site} (要 ${constant})`);
        }
      }
    }
    expect(
      offenders,
      '締切が無い、または経路にふさわしくない締切を渡している fetch。' +
        '確定に読み取り用の 15 秒を渡すと、サーバの予算 30 秒に必ず負けて' +
        '「成功しているのに分からないと言う」状態になる。',
    ).toEqual([]);
    /*
      🔴 **下界。** 走査が空振りすると上の主張は空虚に通る。現在の内訳は 4 箇所:
      在館一覧 GET / 自己特定 resolve / 退館確定（credential 枝）/ 退館確定（stay 枝）。
      減らすときは「本当に消したのか」を確かめてからこの数を下げること。
    */
    expect(checked, '退館フローの fetch を見つけられていない').toBeGreaterThanOrEqual(4);
  });

  /*
   * 🔴 **下界その 2。** 上の主張は「全部 READ を渡す」実装でも満たせてしまう
   * （`expectedDeadline` を常に READ にする変異）。**両方の締切が実際に使われている**
   * ことを別に固定して、片方へ寄せる変異を落とす。
   */
  it('読み取りと確定の締切が両方とも使われている', () => {
    const all = checkoutSources()
      .map((f) => f.source)
      .join('\n');
    expect(all).toContain(`AbortSignal.timeout(${READ})`);
    expect(all).toContain(`AbortSignal.timeout(${CONFIRM})`);
  });
});
