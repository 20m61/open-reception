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
function checkoutSources(dir: string = CHECKOUT_DIR): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    // 🔴 **再帰する**（3 周目 MINOR-2）。非再帰だとサブディレクトリへ移すだけで外れる。
    if (entry.isDirectory()) out.push(...checkoutSources(rel));
    else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.test.'))
      out.push({ rel, source: stripComments(readFileSync(join(ROOT, rel), 'utf8')) });
  }
  return out;
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
 * `const x = startDeadline(<constant>)` で**一意に**束縛された名前。
 *
 * 🔴 **綴りを足し続けない**（3 周目 MAJOR-1）。1 周目「リテラル一致」→ 2 周目「一意束縛」→
 * 3 周目「行頭でない再代入」と、**3 度別の綴りで抜けられた**。#813（ESLint の文法を
 * 手写しして 3 度突破された）と同型である。
 *
 * 前提の側を替えた ―― 締切の生成を `src/domain/ui/deadline.ts` の `startDeadline` 1 箇所へ
 * 集約したので、ここが見るのは **`const` 束縛 1 形だけ**になった（代入形は消えた）。
 * それでも「同名の束縛が 2 つ以上あるなら通さない」は残す（影付けを通さないため）。
 *
 * 🔴 **値そのものは e2e が観測する。** 静的走査だけに頼らない ――
 * `kiosk-checkout-deadline.spec.ts` の「確定は読み取りより長く待つ」が、
 * 定数の**実際の効き方**を本番ビルドで測る。
 */
function uniqueDeadlineNames(source: string, constant: string): string[] {
  const bound = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)].map((m) => m[1] as string);
  const fromHelper = [
    ...source.matchAll(new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*startDeadline\\(${constant}\\)`, 'g')),
  ].map((m) => m[1] as string);
  // 代入で締切を作る形は残っていないこと（残っていれば下の検査が offender として落とす）。
  return fromHelper.filter((n) => bound.filter((b) => b === n).length === 1);
}

/** この `fetch` 引数が、期待する締切を渡しているか。 */
function passesExpectedDeadline(args: string, source: string, constant: string): boolean {
  return uniqueDeadlineNames(source, constant).some((n) =>
    new RegExp(`signal\\s*:\\s*${n}\\.signal\\b`).test(args),
  );
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
  /*
   * 🔴 **標準の 1 行 API（`AbortSignal.timeout`）を直接呼ばない**（3 周目 BLOCKER-1）。
   * Safari 16 からの API なので、iPadOS 15 以前では**呼んだ瞬間に投げて要求が 1 本も
   * 飛ばない**（実測: `gets=0 resolves=0 posts=0`、画面は「通信エラー」）。回線は正常なのに
   * 退館の 3 手段が全滅する。締切の生成は `src/domain/ui/deadline.ts` へ集約する。
   */
  it('退館フローが AbortSignal.timeout を直接呼ばない（古い iPadOS Safari で要求が飛ばない）', () => {
    for (const { rel, source } of checkoutSources()) {
      expect(source, `${rel} が AbortSignal.timeout を直接呼んでいる`).not.toContain('AbortSignal.timeout');
    }
  });

  it('読み取りと確定の締切が両方とも使われている', () => {
    const all = checkoutSources()
      .map((f) => f.source)
      .join('\n');
    expect(all).toContain(`startDeadline(${READ})`);
    expect(all).toContain(`startDeadline(${CONFIRM})`);
  });
});
