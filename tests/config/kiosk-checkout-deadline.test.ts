import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchArguments, fetchSites, stripComments } from '../../src/domain/governance/fetch-failure-scan';

/**
 * 退館フローの `fetch` が**すべて**締切を持つ (#1029)。
 *
 * ## なぜ e2e ではなくここで縛るのか
 *
 * 🔴 **独立レビュー 1 周目 MAJOR-2 の実測**: 退館確定の `signal` を **credential 枝から
 * だけ**外す変異が、**unit 57 本・e2e 23 本を素通り**した。`checkout-confirm-yes` を
 * 押す spec は 2 本あるがどちらも**在館一覧経由**（`pending.kind === 'stay'`）なので、
 * QR / 退館コードで退館する経路（設計上の**主経路**。在館一覧は staff 補助）の確定は
 * スイート全体で一度も踏まれていない。
 *
 * これは #968 が platform で踏んだのと同じ族である ――
 * `tests/config/platform-fetch-failure.test.ts` のコメント:
 *
 * > 6 周目は `AbortSignal.timeout` を 5 経路へ入れたが、**オラクルは e2e の 1 本だけ**
 * > だった。レビューが `PlatformDashboard` と `TenantSwitcher` から `signal` を外す
 * > 変異を当てたところ、unit も e2e も素通りした。
 *
 * その結論も同じにする ―― **配線の実在**を静的に、**帰結**を e2e で見る。
 * e2e で全経路のハングを注入するのは高くつく（本番と同じ締切を使うので 1 本 15〜35 秒）。
 *
 * 走査は `src/domain/governance/fetch-failure-scan.ts` を**共有**する（#968 / #973 が
 * 積み上げたもの。写しを作ると片方に入った修正がもう片方へ入らず、誰も気づかない）。
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** 退館フローで実際に通信する本番ファイル。 */
const CHECKOUT_FETCH_FILES = ['src/components/kiosk/checkout/CheckoutFlow.tsx'] as const;

function read(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

/**
 * `const x = AbortSignal.timeout(...)` で束縛された名前。
 *
 * 🔴 **リテラル一致だけにしない。** 同じ締切を 2 つの `fetch` で共有するとき
 * （退館確定の credential 枝 / stay 枝）、`signal` を変数へ持ち上げるのは正しい書き方で、
 * それを「締切が無い」と数えると**検査が正しいコードを罰する**。逆に `signal:` が
 * 在りさえすればよいことにすると、`signal: someOtherController.signal` を通してしまう。
 * **束縛元まで見る**ことで、どちらにも倒さない。
 */
function deadlineNames(source: string): string[] {
  return [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*AbortSignal\.timeout\(/g)].map(
    (m) => m[1] as string,
  );
}

/** この `fetch` 引数が締切を渡しているか。 */
function hasDeadline(args: string, names: readonly string[]): boolean {
  if (args.includes('AbortSignal.timeout(')) return true;
  return names.some((n) => new RegExp(`signal\\s*:\\s*${n}\\b`).test(args));
}

describe('退館フローの締切 (#1029)', () => {
  it('退館フローの fetch はすべて締切信号を渡す', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const rel of CHECKOUT_FETCH_FILES) {
      const source = read(rel);
      const names = deadlineNames(source);
      for (const site of fetchSites(source)) {
        checked += 1;
        const args = fetchArguments(source, site);
        if (!hasDeadline(args, names)) offenders.push(`${rel}@${site}`);
      }
    }
    expect(offenders, '締切を渡していない fetch（応答が返らないと押せるものが無くなる）').toEqual([]);
    /*
      🔴 **下界。** 走査が空振りすると上の主張は空虚に通る。現在の内訳は 4 箇所:
      在館一覧 GET / 自己特定 resolve / 退館確定（credential 枝）/ 退館確定（stay 枝）。
      減らすときは「本当に消したのか」を確かめてからこの数を下げること。
    */
    expect(checked, '退館フローの fetch を見つけられていない').toBeGreaterThanOrEqual(4);
  });

});
