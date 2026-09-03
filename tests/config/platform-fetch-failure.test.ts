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
      /*
       * 🔴 **拡張子軸で漏らさない (#968 レビュー M4)。** `.tsx` だけを見ると、
       * `usePlatformPing.ts` のような hook へ `fetch` を切り出すだけで**1 バイトも
       * 読まれなくなる**（実測で生存）。ディレクトリ軸（再帰）だけ塞いでも足りない。
       */
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'))
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

/**
 * `fetch(` の呼び出し位置（`res.json().catch(` 等の別メソッドは拾わない）。
 *
 * 🔴 **`window.fetch(` / `globalThis.fetch(` も拾う (#968 レビュー M4)。** `.` を一律に
 * 除外すると、`await window.fetch(...)` へ書き換えるだけで検査から外れる（実測で生存）。
 * レシーバは global を指すものだけ許し、`res.json().catch` のような任意の式は拾わない。
 */
function fetchSites(source: string): number[] {
  return [...source.matchAll(/(?<![\w$.])(?:(?:window|globalThis|self)\.)?fetch\s*\(/g)].map(
    (m) => m.index ?? 0,
  );
}

/**
 * 失敗を**画面へ出す**呼び出し。**閉じた語彙にする** —— 「何か書いてあればよい」に
 * すると `void 0;` 変異の代わりに `noop();` を書けば通ってしまう。
 *
 * 🔴 **引数まで見る (#968 レビュー B2)。** 呼び出し名だけを見ると
 * `setError(null)` / `setActionError('')` が通る —— 画面出力は「報告しない」と
 * **完全に同一**（`{error ? … }` は `null` も `''` も falsy）なのに、検査は満たされる。
 * `void 0;` という**1 つの綴り**を閉じただけで族が閉じていなかった、という指摘そのもの。
 * 中身のある値（文字列リテラル・テンプレート・オブジェクト・関数呼び出し）を要求する。
 */
const FAILURE_REPORT =
  /\b(?:set[A-Za-z]*(?:Error|Failed|Failure)|failure)\s*\(\s*(?!\)|null\s*\)|undefined\s*\)|''\s*\)|""\s*\)|``\s*\)|false\s*\))/;

/** `catch` の中で呼ばれている報告先 setter 名（`setError` → `error`）。 */
function reportedStates(body: string): string[] {
  return [...body.matchAll(/\bset([A-Z][A-Za-z]*(?:Error|Failed|Failure))\s*\(/g)].map(
    (m) => `${(m[1] ?? '').charAt(0).toLowerCase()}${(m[1] ?? '').slice(1)}`,
  );
}

/**
 * 三項の条件から JSX を出している state 名（`ident ? <…>` / `ident !== null ? (<…>`）。
 *
 * 🔴 **先頭の `{` を要求しない。** 三項を連ねると 2 段目以降は `) : ident !== null ? (`
 * の形になり、`{` から始まらない。要求すると**実際に描いているのに「描いていない」**
 * と判定してしまう（`TenantSwitcher` で実際に踏んだ）。
 */
function renderedStates(source: string): string[] {
  return [...source.matchAll(/([A-Za-z_$][\w$]*)\s*(?:!==\s*null\s*)?\?\s*\(?\s*</g)].map(
    (m) => m[1] ?? '',
  );
}

/**
 * `useCallback` / `useEffect` のコールバックと、宣言された関数の本体。
 *
 * `useEffect` も拾う —— 遷移で state を捨てる後始末はそこに置かれる（下の
 * `RESET_ON_SWITCH`）。拾わないと「捨てていない」を検出できない。
 */
function functionBodies(
  source: string,
): { readonly name: string; readonly body: string; readonly start: number; readonly end: number }[] {
  const out: { name: string; body: string; start: number; end: number }[] = [];
  const pattern = /const\s+(\w+)\s*=\s*useCallback\(|(useEffect)\(|(?:async\s+)?function\s+(\w+)\s*\(/g;
  for (const m of source.matchAll(pattern)) {
    const at = m.index ?? 0;
    const isArrow = Boolean(m[1] || m[2]);
    const name = m[1] ?? m[2] ?? m[3] ?? '(無名)';
    const arrow = source.indexOf('=> {', at);
    const brace = isArrow ? (arrow < 0 ? -1 : arrow + 3) : source.indexOf('{', at + m[0].length);
    if (brace < 0) continue;
    const end = matchBrace(source, brace);
    if (end < 0) continue;
    out.push({ name, body: source.slice(brace, end), start: brace, end });
  }
  return out;
}

/**
 * 応答が**遷移をまたいで後着しうる**関数。世代 ref の名前を名指しする (#968 レビュー B1 / M3)。
 *
 * これらの関数は「いま画面が指している対象」が `await` の前後で変わりうる。守らないと:
 *
 * - `TenantDetail.runLifecycle` … A の停止失敗が **B の停止ボタンの真上**に出る。
 *   「成功したか分からない」より悪い、**誤ったテナントへの帰属**になる
 * - `FeatureFlags.loadTenantFlags` … 後着した A の flags が載り、`toggle` はその値から
 *   enable を計算して **B 宛に昇格つき PATCH** を撃つ。監査には「B を変更」と正しく残る
 */
const GENERATION_GUARDED: readonly {
  readonly file: string;
  readonly fn: string;
  readonly ref: string;
  readonly why: string;
}[] = [
  {
    file: 'TenantDetail.tsx',
    fn: 'load',
    ref: 'latestTenantId',
    why: 'tenantId ごとに load を作り直すので、A→B 遷移直後に A の応答が成否とも後着しうる',
  },
  {
    file: 'TenantDetail.tsx',
    fn: 'runLifecycle',
    ref: 'latestTenantId',
    why: 'PATCH の応答が遷移をまたいで後着すると、破壊的操作の失敗が別テナントの画面に出る',
  },
  {
    file: 'FeatureFlags.tsx',
    fn: 'loadTenantFlags',
    ref: 'latestTenantId',
    why: '選択し直した直後に前テナントの flags が載ると、その値を根拠に昇格つき PATCH を組み立てる',
  },
];

/**
 * 対象が切り替わったときに**捨てる** state (#968 レビュー B1)。
 *
 * 分離前は同じ文言が読み取りの `error` に載っており、遷移後の `load()` 成功が
 * `setError(null)` で必ず消していた。AC4 のために state を分けると**その消去経路が落ちる**。
 * 世代 ref へ代入する本体（＝切り替えを認識する場所）で捨てることを要求する。
 */
const RESET_ON_SWITCH: readonly { readonly file: string; readonly setter: string; readonly why: string }[] = [
  {
    file: 'TenantDetail.tsx',
    setter: 'setActionError',
    why: '操作の失敗を読み取りの error から分離した結果、遷移時の消去経路が無くなるため',
  },
  {
    file: 'FeatureFlags.tsx',
    setter: 'setReadError',
    why: '読み取りの失敗を writeError から分離した結果、選択し直しでの消去経路が無くなるため',
  },
  {
    file: 'FeatureFlags.tsx',
    setter: 'setWriteError',
    why: '前テナントへの書込失敗を、別テナントを選んだ画面に残さないため',
  },
];

/**
 * 一覧を書き換える（＝操作系の）本体か。
 *
 * 🔴 **引用符の種類に依存させない (#968 レビュー M1)。** `method: 'PATCH'` だけを見ると、
 * prettier の設定を変えて `"PATCH"` にするだけで AC4 の検査が無効化される（実測で生存）。
 */
function isMutating(body: string): boolean {
  return /method:\s*['"`](PATCH|POST|PUT|DELETE)/.test(body);
}

/**
 * `catch` に囲まれていなくてよい `fetch`。**理由を必ず書く。**
 *
 * 免除は `file` と `marker`（その呼び出しを一意に指す文字列）で持つ。ファイル単位に
 * すると、同じファイルの別の `fetch` が黙って免除される —— 本テストが存在する理由
 * そのものになってしまう。
 */
const EXEMPT_FETCH: readonly { readonly file: string; readonly marker: string; readonly why: string }[] = [];

/*
 * 🔴 **いまは空である（#968 レビュー M5）。**
 *
 * 最初は `TenantSwitcher.onSelect` を「`.catch(() => null)` の戻りを `if (!res?.ok)` で
 * 判定し、選択表示を戻すので失敗が画面に見える」という理由で登録していた。**その理由が
 * 事実と違った** —— 実際にやっていたのは `setSelectedId(prevId)` だけで、メッセージも
 * `role="alert"` も出ず、運用者から見えるのは「プルダウンが勝手に戻る」挙動だけだった。
 * しかも切替は監査に残す操作（#83 §5）で、失敗すると読み取りスコープが変わったつもりで
 * 変わっていない状態になる —— まさに本 issue が問題にしている無言の通信失敗である。
 *
 * 免除簿は「黙って増やせない」ことは縛れるが、**書かれた理由が正しいかは誰も検査できない**。
 * 1 件目の記録が誤っていると、以降の免除の判断基準として機能しなくなる。だから免除ではなく
 * 実装（`switchError` + `role="alert"`）で塞いだ。**空のまま保つことが最も強い状態**である。
 */

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
      /*
       * 🔴 **`failed={…}` の**式全体**から識別子を拾う (#968 レビュー M1)。**
       * `!== null` の綴りだけを見ると `failed={Boolean(error)}` へ書き換えるだけで
       * AC4 の検査が外れる（実測で生存）。式に現れる識別子すべてを読み取り側の
       * state 候補として扱い、対応する setter を操作系から締め出す。
       */
      const feeders = [...f.source.matchAll(/\bfailed=\{([^}]*)\}/g)].flatMap((m) =>
        [...(m[1] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)]
          .map((id) => id[0])
          .filter((id) => !['Boolean', 'null', 'undefined', 'true', 'false'].includes(id))
          .map((id) => `set${id.charAt(0).toUpperCase()}${id.slice(1)}`),
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
   * 🔴 **secret は「送る前に」画面から消す (#968 / レビュー m1)。**
   *
   * 元のコードは `await fetch(...)` の**次の行**でクリアしていた。HTTP エラーでは通るが、
   * **reject したときだけそこへ到達しない** —— 通信が切れたときにだけ secret が入力欄
   * （＝DOM）に残り続ける。`finally` へ移すと今度は**成功経路で `await load()` の 1 往復ぶん
   * 残る**（レビュー m1 の実測）。どちらも「即クリア」というコメントを嘘にする。
   *
   * 送信前に消せば両方起こらない。**`fetch` より前**にクリアが在ることを縛る ——
   * `finally` に置き直す変異も、元の位置へ戻す変異も、どちらもここで落ちる。
   * `.claude/rules/pii-secret-minimization.md`「画面・DOM に残さない」。
   */
  it('secret 入力欄のクリアは送信より前に置く（往復のあいだ DOM に残さない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const clears = [...f.source.matchAll(/setSecretInput\(''\)/g)].map((m) => m.index ?? 0);
      if (clears.length === 0) return [];
      const bodies = functionBodies(f.source);
      const sites = fetchSites(f.source);
      return clears
        .map((at) => {
          // clear を囲む最も内側の関数の中で、送信より前に居ること。
          const fn = bodies
            .filter((b) => at > b.start && at < b.end)
            .sort((a, b) => b.start - a.start)[0];
          if (!fn) return `${f.name}: setSecretInput('') を囲む関数が見つからない`;
          const sent = sites.find((site) => site > fn.start && site < fn.end);
          if (sent === undefined) return `${f.name}: ${fn.name} に送信が無いのにクリアしている`;
          return at < sent ? null : `${f.name}: ${fn.name} の setSecretInput('') が送信より後ろに在る`;
        })
        .filter((x): x is string => x !== null);
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

  /*
   * 🔴 **例外の中身を失敗メッセージへ混ぜない (#968 レビュー m4)。**
   *
   * 同じディレクトリの `ProviderConfig` は `WARNING_TEXT` について「応答に自由文を載せると、
   * そこへ設定値や secret の断片が混ざりうる」と自分で書いている。いまの `fetch` の reject は
   * `TypeError: Failed to fetch` 程度で実害は小さいが、新ガードはこれらの catch を「正しい」と
   * 認定するので、将来 `error.cause` や応答 body を混ぜる変更を**止められない**。
   *
   * 文言は定型（文字列リテラル）に保つ。テンプレートリテラルを禁じれば
   * `setError(\`… ${String(e)}\`)` の族がまとめて落ちる（実測でこの形が生存していた）。
   */
  it('fetch を囲む catch はテンプレートリテラルを使わない（例外の中身を混ぜない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      const blocks = tryCatchBlocks(f.source);
      return fetchSites(f.source)
        .flatMap((site) => {
          const enclosing = blocks
            .filter((b) => site > b.tryBody.start && site < b.tryBody.end)
            .sort((a, b) => b.tryBody.start - a.tryBody.start)[0];
          if (!enclosing) return [];
          const body = f.source.slice(enclosing.catchBody.start, enclosing.catchBody.end);
          return body.includes('`') ? [`${f.name}: catch にテンプレートリテラルが在る`] : [];
        });
    });
    expect([...new Set(offenders)]).toEqual([]);
  });

  /*
   * 🔴 **`await` の後ろの state 更新は世代ガードを通す (#968 レビュー B1 / M3)。**
   *
   * `catch` を足すこと自体が新しい穴を開けうる、というのは #896 で一度学んだ形である。
   * 今回もその族を 2 つ作っていた（`runLifecycle` の失敗報告・`loadTenantFlags` の成功枝）。
   * 「ガードが在る」だけでは足りないので、**`await` より後ろのすべての `set…(` が
   * 世代比較より後ろに在ること**を要求する（1 箇所だけ守る変異を落とす）。
   */
  it.each(GENERATION_GUARDED.map((g) => [`${g.file}:${g.fn}`, g] as const))(
    '%s: await の後ろの state 更新は世代ガードを通す',
    (_label, g) => {
      const file = platformFiles().find((f) => f.name === g.file);
      expect(file, `${g.file} が無い`).toBeDefined();
      const fn = functionBodies(file?.source ?? '').find((b) => b.name === g.fn);
      expect(fn, `${g.file} に ${g.fn} が無い`).toBeDefined();
      const body = fn?.body ?? '';
      const firstAwait = body.indexOf('await');
      expect(firstAwait, `${g.fn} に await が無い（登録が腐っている）`).toBeGreaterThan(-1);
      const guards = [...body.matchAll(new RegExp(`${g.ref}\\.current\\s*[!=]==`, 'g'))].map(
        (m) => m.index ?? 0,
      );
      expect(guards.length, `${g.fn} に ${g.ref}.current の比較が無い`).toBeGreaterThan(0);
      const unguarded = [...body.matchAll(/\bset[A-Z]\w*\s*\(/g)]
        .map((m) => ({ at: m.index ?? 0, call: m[0] }))
        .filter((x) => x.at > firstAwait)
        .filter((x) => !guards.some((gAt) => gAt < x.at))
        .map((x) => `${g.fn}: ${x.call} が世代ガードより前に在る`);
      expect(unguarded).toEqual([]);

      /*
       * 🔴 **`catch` 本体は自分でガードを持つ (#968 レビュー B1)。**
       *
       * 「関数のどこかにガードが在る」だけでは足りない —— try 側のガードが `catch` の
       * 報告より**テキスト上は前**に在るので、catch のガードを `if (true)` へ変える変異が
       * 素通りした（実測で生存）。catch は try の途中から飛んでくるので、try 側のガードを
       * 通っている保証がまったく無い。**catch 本体の中**にガードを要求する。
       */
      const catchOffenders = tryCatchBlocks(body).flatMap((b) => {
        const cb = body.slice(b.catchBody.start, b.catchBody.end);
        const sets = [...cb.matchAll(/\bset[A-Z]\w*\s*\(/g)].map((m) => ({ at: m.index ?? 0, call: m[0] }));
        if (sets.length === 0) return [];
        const inner = [...cb.matchAll(new RegExp(`${g.ref}\\.current\\s*[!=]==`, 'g'))].map(
          (m) => m.index ?? 0,
        );
        return sets
          .filter((x) => !inner.some((gAt) => gAt < x.at))
          .map((x) => `${g.fn}: catch の ${x.call} が ${g.ref} のガードを通らない`);
      });
      expect(catchOffenders).toEqual([]);
    },
  );

  /*
   * 🔴 **切り替えを認識する場所で、前の対象の失敗表示を捨てる (#968 レビュー B1)。**
   */
  it.each(RESET_ON_SWITCH.map((r) => [`${r.file}:${r.setter}`, r] as const))(
    '%s: 世代 ref へ代入する本体が null で捨てる',
    (_label, r) => {
      const file = platformFiles().find((f) => f.name === r.file);
      expect(file, `${r.file} が無い`).toBeDefined();
      /*
       * 🔴 **「最も内側」の本体で見る。** コンポーネント関数そのものも `functionBodies` に
       * 出るので、素朴に `filter` すると**コンポーネント全体**が「切り替え本体」に化け、
       * 別の関数（`runLifecycle`）が持つ `setActionError(null)` で満たされてしまう
       * ——「遷移時に捨てるのをやめる」変異が素通りした（実測で生存）。
       */
      const bodies = functionBodies(file?.source ?? '');
      const assignments = [...(file?.source ?? '').matchAll(/\w+\.current\s*=[^=]/g)].map(
        (m) => m.index ?? 0,
      );
      expect(assignments.length, `${r.file} に世代 ref への代入が無い`).toBeGreaterThan(0);
      const switching = assignments
        .map((at) => bodies.filter((b) => at > b.start && at < b.end).sort((a, b) => b.start - a.start)[0])
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      expect(switching.length, `${r.file} に世代 ref へ代入する本体が無い`).toBeGreaterThan(0);
      const resets = switching.filter((b) => b.body.includes(`${r.setter}(null)`));
      expect(resets.length, `${r.setter}(null) を呼ぶ切り替え本体が無い`).toBeGreaterThan(0);
    },
  );

  it('🔴 登録簿には理由が書かれ、固定されている（黙って外せない）', () => {
    expect(GENERATION_GUARDED.filter((g) => g.why.trim().length < 10)).toEqual([]);
    expect(RESET_ON_SWITCH.filter((r) => r.why.trim().length < 10)).toEqual([]);
    expect(GENERATION_GUARDED.map((g) => `${g.file}:${g.fn}`)).toEqual([
      'TenantDetail.tsx:load',
      'TenantDetail.tsx:runLifecycle',
      'FeatureFlags.tsx:loadTenantFlags',
    ]);
    expect(RESET_ON_SWITCH.map((r) => `${r.file}:${r.setter}`)).toEqual([
      'TenantDetail.tsx:setActionError',
      'FeatureFlags.tsx:setReadError',
      'FeatureFlags.tsx:setWriteError',
    ]);
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
    expect(EXEMPT_FETCH.map((e) => `${e.file}:${e.marker}`)).toEqual([]);
  });
});
