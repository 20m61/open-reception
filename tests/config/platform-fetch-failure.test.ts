import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * platform の通信失敗が無言にならない (#968)。
 *
 * ## なぜファイル単位では足りないか
 *
 * `tests/config/platform-list-states.test.ts` は「`failed` を式で渡すファイルは、失敗を
 * 報告する `catch` を持つ」を**ファイル単位**で見ている。`TenantDetail` はその主張を
 * `load` の `catch` だけで満たすので、**同じファイルの `runLifecycle`（テナントの停止 /
 * 有効化という破壊的操作）に `catch` が無いことを一度も落とせなかった** ——
 * `fetch` が reject すると例外は `void` に捨てられ、`busy` が戻るだけで画面に何も出ない。
 * 押した運用者は「何も起きなかった」と読み、もう一度押すか、成功したと誤解する。
 *
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」と同じ根で、
 * **母集団の粒度がずれていると、粒度の中に隠れた欠陥は原理的に見えない**。
 * ここは粒度を **`fetch` の呼び出し 1 件**に落とす。
 *
 * ## 前の方式が守っていた変異を当て直す
 *
 * | 前の方式（ファイル単位）が殺していた変異 | ここでの対応 |
 * | --- | --- |
 * | 読み取りの `catch` を丸ごと消す | 「全 `fetch` が `catch` に囲まれる」 |
 * | `catch` の中身を `void 0;` にする | 「囲む `catch` は失敗を報告する呼び出しを持つ」 |
 * | 免除を黙って足す | 免除簿の同一性固定 + 理由 + ちょうど 1 件に当たること |
 *
 * ## ここで新しく殺す族（ファイル単位では届かなかったもの）
 *
 * | 変異 | 落ちる主張 |
 * | --- | --- |
 * | 1 ファイルの 2 つ目以降の `fetch` から `catch` を外す | 「全 `fetch` が `catch` に囲まれる」 |
 * | 操作の失敗を読み取りの `error` に載せる | 「操作の失敗は読み取りと別の state に載せる」 |
 * | 報告先の state を画面に描かない | 「catch が書く state は画面に描かれる」 |
 *
 * ## 走査の限界を自分で検出する
 *
 * ブレース対応は文字列・テンプレートリテラルを飛ばす自前の走査で取る。正規表現リテラルの
 * 中の `{` は飛ばさないので、将来そういう記述が入ると**黙って取りこぼす**。それを
 * 「欠陥が無い」と読ませないため、**`} catch` の出現数と拾えたブロック数が一致すること**を
 * 別に要求する（走査が壊れたら落ちる）。
 */

const PLATFORM_DIR = join(process.cwd(), 'src/components/admin/platform');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function platformFiles(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, name);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
        out.push({ name, source: stripComments(readFileSync(path, 'utf8')) });
    }
  };
  walk(PLATFORM_DIR, '');
  return out;
}

/** 文字列 / テンプレートリテラルの終端（閉じ引用符）の位置。`${}` の入れ子も飛ばす。 */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === quote) return i;
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      const end = matchBrace(source, i + 1);
      if (end < 0) return source.length;
      i = end - 1;
    }
  }
  return source.length;
}

/** `from`（`{` の位置）に対応する `}` の**次**の位置。見つからなければ -1。 */
function matchBrace(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

type Block = { readonly start: number; readonly end: number };

/** `try { … } catch (…) { … }` の try 本体と catch 本体。入れ子も全部返す。 */
function tryCatchBlocks(source: string): { readonly tryBody: Block; readonly catchBody: Block }[] {
  const out: { tryBody: Block; catchBody: Block }[] = [];
  for (const m of source.matchAll(/\btry\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const tryEnd = matchBrace(source, open);
    if (tryEnd < 0) continue;
    const rest = source.slice(tryEnd);
    const catchHead = /^\s*catch\s*(\([^)]*\)\s*)?\{/.exec(rest);
    if (!catchHead) continue;
    const catchOpen = tryEnd + catchHead[0].length - 1;
    const catchEnd = matchBrace(source, catchOpen);
    if (catchEnd < 0) continue;
    out.push({ tryBody: { start: open, end: tryEnd }, catchBody: { start: catchOpen, end: catchEnd } });
  }
  return out;
}

/** `fetch(` の呼び出し位置（`res.json().catch(` 等の別メソッドは拾わない）。 */
function fetchSites(source: string): number[] {
  return [...source.matchAll(/(?<![\w.])fetch\s*\(/g)].map((m) => m.index ?? 0);
}

/**
 * 失敗を**画面へ出す**呼び出し。**閉じた語彙にする** —— 「何か書いてあればよい」に
 * すると `void 0;` 変異の代わりに `noop();` を書けば通ってしまう。
 */
const FAILURE_REPORT = /\bset[A-Za-z]*(Error|Failed|Failure)\s*\(|\bfailure\s*\(/;

/** `catch` の中で呼ばれている報告先 setter 名（`setError` → `error`）。 */
function reportedStates(body: string): string[] {
  return [...body.matchAll(/\bset([A-Z][A-Za-z]*(?:Error|Failed|Failure))\s*\(/g)].map(
    (m) => `${(m[1] ?? '').charAt(0).toLowerCase()}${(m[1] ?? '').slice(1)}`,
  );
}

/** `{ ident ? <…>` / `{ ident ? (<…>` の形で描かれている state 名。 */
function renderedStates(source: string): string[] {
  return [...source.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*(?:!==\s*null\s*)?\?\s*\(?\s*</g)].map(
    (m) => m[1] ?? '',
  );
}

/** `const foo = useCallback(async … => { … })` / `function foo(…) { … }` の本体。 */
function functionBodies(source: string): { readonly name: string; readonly body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of source.matchAll(/(?:const\s+(\w+)\s*=\s*useCallback\(|async\s+function\s+(\w+)\s*\()/g)) {
    const name = m[1] ?? m[2] ?? '(無名)';
    const arrow = source.indexOf('=> {', m.index ?? 0);
    const brace = m[1] ? (arrow < 0 ? -1 : arrow + 3) : source.indexOf('{', (m.index ?? 0) + m[0].length);
    if (brace < 0) continue;
    const end = matchBrace(source, brace);
    if (end < 0) continue;
    out.push({ name, body: source.slice(brace, end) });
  }
  return out;
}

/** 一覧を書き換える（＝操作系の）本体か。 */
function isMutating(body: string): boolean {
  return /method:\s*'(PATCH|POST|PUT|DELETE)'/.test(body);
}

/**
 * `catch` に囲まれていなくてよい `fetch`。**理由を必ず書く。**
 *
 * 免除は `file` と `marker`（その呼び出しを一意に指す文字列）で持つ。ファイル単位に
 * すると、同じファイルの別の `fetch` が黙って免除される —— 本テストが存在する理由
 * そのものになってしまう。
 */
const EXEMPT_FETCH: readonly { readonly file: string; readonly marker: string; readonly why: string }[] = [
  {
    file: 'TenantSwitcher.tsx',
    marker: "'/api/platform/selected-tenant'",
    why: 'TenantSwitcher.onSelect: `.catch(() => null)` の戻りを `if (!res?.ok)` で判定し、選択表示を切替前へ戻す（失敗が画面に見える形で残る）',
  },
];

function isExemptFetch(file: string, source: string, site: number): boolean {
  return EXEMPT_FETCH.some((e) => {
    if (e.file !== file) return false;
    const idx = source.indexOf(e.marker, site);
    // 同じ `fetch(…)` の引数の中に marker が在ることを、次の `fetch(` より手前で見る。
    const next = fetchSites(source).find((s) => s > site);
    return idx > site && (next === undefined || idx < next);
  });
}

describe('platform の通信失敗が無言にならない (#968)', () => {
  it('🔴 下界: fetch の呼び出しを 10 件以上見つけている（走査が空振りしていない）', () => {
    const total = platformFiles().reduce((n, f) => n + fetchSites(f.source).length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('🔴 走査の健全性: `} catch` の出現数と拾えた try/catch の数が一致する', () => {
    const offenders = platformFiles()
      .map((f) => ({
        name: f.name,
        text: (f.source.match(/\}\s*catch\b/g) ?? []).length,
        parsed: tryCatchBlocks(f.source).length,
      }))
      .filter((x) => x.text !== x.parsed)
      .map((x) => `${x.name}: 文字列 ${x.text} 件 / 走査 ${x.parsed} 件`);
    expect(offenders, 'ブレース走査が取りこぼしている（本テストの主張が空虚になる）').toEqual([]);
  });

  /*
   * 🔴 **主修正 (#968 AC1 / AC2)。** `fetch` は HTTP エラーだけでなく **reject** する ——
   * オフライン・DNS 断・接続断・CORS。`if (!res.ok)` だけ書いてあっても、reject した
   * ときはその行に到達しない。囲っていなければ例外は `void` に捨てられ、画面には
   * 何も出ない。
   */
  it('すべての fetch は catch に囲まれている（reject を void に捨てない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const blocks = tryCatchBlocks(f.source);
      return fetchSites(f.source)
        .filter((site) => !isExemptFetch(f.name, f.source, site))
        .filter((site) => !blocks.some((b) => site > b.tryBody.start && site < b.tryBody.end))
        .map((site) => `${f.name}: ${f.source.slice(site, site + 60).replace(/\s+/g, ' ')}…`);
    });
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **`catch` を足しただけでは足りない (#968 AC3)。** PR #965 の独立レビューは
   * catch の中身を `void 0;` に置換して**生存**させた。囲む catch が失敗を
   * **報告している**ことまで要求する。
   */
  it('fetch を囲む catch は失敗を報告する（中身を void 0 にできない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const blocks = tryCatchBlocks(f.source);
      return fetchSites(f.source)
        .filter((site) => !isExemptFetch(f.name, f.source, site))
        .flatMap((site) => {
          const enclosing = blocks
            .filter((b) => site > b.tryBody.start && site < b.tryBody.end)
            .sort((a, b) => b.tryBody.start - a.tryBody.start)[0];
          if (!enclosing) return [];
          const body = f.source.slice(enclosing.catchBody.start, enclosing.catchBody.end);
          return FAILURE_REPORT.test(body)
            ? []
            : [`${f.name}: ${f.source.slice(site, site + 48).replace(/\s+/g, ' ')}… の catch が無音`];
        });
    });
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **報告先が画面に無いと、報告しても無言のまま (#968 AC1)。**
   *
   * `setActionError` を足しても、その state を描かなければ運用者には何も見えない。
   * 「catch が書く state は画面に描かれる」まで要求して、**state を足しただけ**の
   * 変異を落とす。描画側の `role="alert"` は `platform-list-states.test.ts` が縛る。
   */
  it('catch が書く state は画面に描かれる（報告先が画面に無い形にしない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const rendered = new Set(renderedStates(f.source));
      return tryCatchBlocks(f.source)
        .flatMap((b) => reportedStates(f.source.slice(b.catchBody.start, b.catchBody.end)))
        .filter((state) => !rendered.has(state))
        .map((state) => `${f.name}: ${state} を描いていない`);
    });
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **操作の失敗で一覧を「読み込めませんでした」に化けさせない (#968 AC4)。**
   *
   * `TenantDetail` は `failed={error !== null}` で `DataTable` の 3 状態を決めているのに、
   * 同じ `error` へ `runLifecycle`（PATCH）の失敗も載せていた。停止に失敗しただけで
   * サイト一覧が「読み込めませんでした」へ落ちる —— 読めているのに読めていないと言う。
   *
   * 読み取りの失敗を載せる state に、操作系（`method:` を持つ本体）が書かないこと。
   */
  it('操作の失敗は読み取りの失敗と別の state に載せる', () => {
    const offenders = platformFiles().flatMap((f) => {
      const feeders = [...f.source.matchAll(/\bfailed=\{\s*([A-Za-z_$][\w$]*)\s*!==\s*null/g)].map(
        (m) => `set${(m[1] ?? '').charAt(0).toUpperCase()}${(m[1] ?? '').slice(1)}`,
      );
      return functionBodies(f.source)
        .filter((fn) => isMutating(fn.body))
        .flatMap((fn) =>
          [...new Set(feeders)]
            .filter((setter) => fn.body.includes(`${setter}(`))
            .map((setter) => `${f.name}: ${fn.name} が読み取りの ${setter} を呼んでいる`),
        );
    });
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: 操作系の本体を実際に見つけている（走査が空振りしていない）', () => {
    const mutating = platformFiles().flatMap((f) => functionBodies(f.source).filter((fn) => isMutating(fn.body)));
    expect(mutating.length).toBeGreaterThanOrEqual(5);
  });

  /*
   * 🔴 **secret の入力欄は「成否に関わらず」クリアする (#968)。**
   *
   * 元のコードは `await fetch(...)` の**次の行**でクリアしていた。HTTP エラーでは通るが、
   * **reject したときだけそこへ到達しない** —— つまり通信が切れたときにだけ secret が
   * 入力欄（＝DOM）に残り続ける。`.claude/rules/pii-secret-minimization.md` が
   * 「画面・DOM に残さない」と言っている当のものが、一番残ってほしくない失敗時にだけ残る。
   *
   * `catch` を足すだけでは直らない（`catch` の中でクリアを書き忘れる形が残る）ので、
   * **`finally` に置くこと**を機械で縛る。
   */
  it('secret 入力欄のクリアは finally に置く（失敗時だけ DOM に残る形にしない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const clears = [...f.source.matchAll(/setSecretInput\(''\)/g)].map((m) => m.index ?? 0);
      if (clears.length === 0) return [];
      const finallies = [...f.source.matchAll(/\bfinally\s*\{/g)]
        .map((m) => {
          const open = (m.index ?? 0) + m[0].length - 1;
          return { start: open, end: matchBrace(f.source, open) };
        })
        .filter((b) => b.end > 0);
      return clears
        .filter((at) => !finallies.some((b) => at > b.start && at < b.end))
        .map(() => `${f.name}: setSecretInput('') が finally の外に在る`);
    });
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: secret 入力欄のクリアが実在する（消して通す形にしない）', () => {
    const clears = platformFiles().reduce(
      (n, f) => n + (f.source.match(/setSecretInput\(''\)/g) ?? []).length,
      0,
    );
    expect(clears).toBeGreaterThanOrEqual(1);
  });

  it('免除には理由が書かれている', () => {
    expect(EXEMPT_FETCH.filter((e) => e.why.trim().length < 10).map((e) => e.marker)).toEqual([]);
  });

  it('🔴 免除はちょうど 1 つの fetch に当たる（広すぎる marker を書かせない）', () => {
    const offenders = EXEMPT_FETCH.map((e) => {
      const hits = platformFiles().flatMap((f) =>
        fetchSites(f.source).filter((site) => f.name === e.file && isExemptFetch(f.name, f.source, site)),
      ).length;
      return { marker: e.marker, hits };
    })
      .filter((x) => x.hits !== 1)
      .map((x) => `${x.marker} → ${x.hits} 件`);
    expect(offenders).toEqual([]);
  });

  it('🔴 免除は固定（黙って増やせない）', () => {
    expect(EXEMPT_FETCH.map((e) => `${e.file}:${e.marker}`)).toEqual([
      "TenantSwitcher.tsx:'/api/platform/selected-tenant'",
    ]);
  });
});
