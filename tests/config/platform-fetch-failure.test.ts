import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

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

function platformFiles(): { name: string; source: string; absolute: string }[] {
  const out: { name: string; source: string; absolute: string }[] = [];
  const seen = new Set<string>();
  const add = (absolute: string, name: string): void => {
    if (seen.has(absolute)) return;
    seen.add(absolute);
    out.push({ name, source: stripComments(readFileSync(absolute, 'utf8')), absolute });
  };
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
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) add(path, name);
    }
  };
  walk(PLATFORM_DIR, '');

  /*
   * 🔴 **ディレクトリの外へ出す軸も塞ぐ (#968 レビュー m-3)。**
   *
   * 拡張子軸と再帰を塞いでも、`fetch` を `src/lib/platform/switch-tenant.ts` のような
   * **隣のディレクトリの helper へ移す**だけで母集団から丸ごと外れる（実測で生存。
   * `TenantSwitcher` は既に `@/lib/platform/selected-tenant` を import しているので、
   * これは仮想的な逃げ道ではなく自然な置き場所である）。
   *
   * platform の画面から**到達できる module** を推移的に足す。サーバ専用の module
   * （API route からしか呼ばれないもの、例: `aws-cost-explorer.ts`）は誰も import して
   * いないので入らない —— そこの `fetch` は throw して route が扱うのが正しい。
   */
  const resolve = (spec: string, fromDir: string): string | undefined => {
    const base = spec.startsWith('@/')
      ? join(process.cwd(), 'src', spec.slice(2))
      : spec.startsWith('.')
        ? join(fromDir, spec)
        : undefined;
    if (base === undefined) return undefined;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')])
      if (existsSync(candidate)) return candidate;
    return undefined;
  };
  for (let i = 0; i < out.length; i += 1) {
    const current = out[i];
    if (!current) continue;
    const dir = dirname(current.absolute);
    for (const m of current.source.matchAll(/from\s+'([^']+)'/g)) {
      const target = resolve(m[1] ?? '', dir);
      if (target && !target.includes('.test.')) add(target, relative(join(process.cwd(), 'src'), target));
    }
  }
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
const FAILURE_CALL = /\b(?:set[A-Za-z]*(?:Error|Failed|Failure)|failure)\s*\(/g;

/**
 * **画面に何も出ない**引数 (#968 レビュー m-2)。
 *
 * 最初は `null` / `undefined` / `''` / `""` / `` `` `` / `false` を列挙して弾いていたが、
 * 独立レビューが `setActionError(' ')`（**空白 1 文字**）を当てて生存させた —— 空白だけの
 * 文字列は truthy なので `{actionError ? …}` は真になり、`role="alert"` の**空の段落**が
 * 描かれる。画面にも読み上げにも何も出ないのに、検査は「報告している」と判定する。
 *
 * 引用符の**中身が空白だけ**であることまで見る形へ替えた（`\s*` を挟む）。逆に、計算された
 * 式（三項・関数呼び出し・オブジェクト）は静的には空かどうか判定できないので**通す** ——
 * ここで閉じられるのは「リテラルとして空」の族だけである、と明示しておく。
 */
const EMPTY_ARGUMENT = /^\s*(?:null|undefined|false|0|(['"`])\s*\1)\s*[,)]/;

/** 失敗を**画面へ出す**呼び出しが在るか。 */
function reportsFailure(body: string): boolean {
  for (const m of body.matchAll(FAILURE_CALL)) {
    const rest = body.slice((m.index ?? 0) + m[0].length);
    if (!EMPTY_ARGUMENT.test(rest)) return true;
  }
  return false;
}

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
  /**
   * `await` の前も含め、**あらゆる state 更新より前**にガードすること。
   *
   * 引数で対象を受け取る関数（`loadTenantFlags(id)`）は、古い id で呼ばれること自体が
   * 起こる。`setFlags(null)` のような「前置きの初期化」がガードより前に在ると、
   * **古い呼び出しがいま見ている対象の表示を消す**（#968 レビュー B-1 の後半）。
   * 現在の対象に対して働く関数（`toggle` / `runLifecycle`）は、押した時点の初期化が
   * 先に来てよいので false。
   */
  readonly guardFirst?: boolean;
  readonly why: string;
}[] = [
  {
    file: 'TenantDetail.tsx',
    fn: 'load',
    ref: 'latestTenantId',
    why: '現 routing では防御的（詳細→詳細は必ず一覧を経由し unmount する）。詳細リンクが next/link 化された時点で到達するので、先に張っておく',
  },
  {
    file: 'TenantDetail.tsx',
    fn: 'runLifecycle',
    ref: 'latestTenantId',
    why: '同上。PATCH の応答が遷移をまたぐと破壊的操作の失敗が別テナントの画面に出る',
  },
  {
    file: 'FeatureFlags.tsx',
    fn: 'loadTenantFlags',
    ref: 'latestTenantId',
    guardFirst: true,
    why: '選択し直した直後に前テナントの flags が載ると、その値を根拠に昇格つき PATCH を組み立てる。さらに古い id での再取得が setFlags(null) でいま見ている対象を消し、「読み込み中…」すら出ない空白を作る',
  },
  {
    file: 'FeatureFlags.tsx',
    fn: 'toggle',
    ref: 'latestTenantId',
    why: '<select> は 1 マウント内で対象が変わる唯一の場所。昇格つき破壊的 PATCH の成否が別テナントの画面へ誤帰属する',
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
    setter: 'setFlagsError',
    why: '読み取りの失敗を writeError から分離した結果、選択し直しでの消去経路が無くなるため',
  },
  {
    file: 'FeatureFlags.tsx',
    setter: 'setWriteError',
    why: '前テナントへの書込失敗を、別テナントを選んだ画面に残さないため',
  },
];

/**
 * `failed={…}` に許す式の形 (#968 レビュー M-2)。
 *
 * 🔴 **式の中身から識別子を拾う形は、`const` 別名 1 つで巻き戻せる。** レビューの実測では
 * `const readFailed = error !== null;` を挟んで `failed={readFailed}` にすると、feeder が
 * `setReadFailed`（誰も呼ばない名前）になり、**AC4 の検査ごと空振り**した。綴りを 1 つずつ
 * 潰しても族は閉じないので、**式の形そのものを閉じる**: `failed={<state> !== null}` だけを
 * 許し、それ以外は定数免除（`CONSTANT_READ_STATE`）に載っていることを要求する。
 */
const FAILED_EXPRESSION = /^\s*([A-Za-z_$][\w$]*)\s*!==\s*null\s*$/;

/**
 * `if (… !res.ok …)` の枝（本体つき）。
 *
 * 🔴 **波括弧の無い形も拾う。** `if (!res.ok) return;` は 1 行で「無言」を書ける最短の形で、
 * `\)\s*\{` を要求すると**その 1 行だけが検査から外れる**（実測で生存）。
 */
function notOkBranches(source: string): { readonly condition: string; readonly body: string }[] {
  // `res` / `response` の `.ok` だけを見る。`Result` 型の `.ok`（`built.ok` / `scoped.ok`）は別物。
  return [...source.matchAll(/if\s*\(([^)]*!(?:res|response)\??\.ok[^)]*)\)\s*/g)].flatMap((m) => {
    const after = (m.index ?? 0) + m[0].length;
    const condition = (m[1] ?? '').trim();
    if (source[after] === '{') {
      const end = matchBrace(source, after);
      return end < 0 ? [] : [{ condition, body: source.slice(after, end) }];
    }
    const semicolon = source.indexOf(';', after);
    return semicolon < 0 ? [] : [{ condition, body: source.slice(after, semicolon + 1) }];
  });
}

/** `<DataTable … />` を粗く切り出す（`platform-list-states.test.ts` と同じ形）。 */
function dataTableBlocks(source: string): string[] {
  return [...source.matchAll(/<DataTable\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/**
 * `failed` を定数に束ねてよい一覧。**同一性で固定する。**
 * 判断の正本は `tests/config/platform-list-states.test.ts` の `CONSTANT_READ_STATE` で、
 * ここはその testId を写している（両方が同じ 1 件を指していることを下で確かめる）。
 */
const FAILED_CONSTANT_ALLOWED: readonly string[] = ['aws-cost-breakdown'];

/** `failed={…}` が指している読み取り state の setter 名。 */
function failedFeeders(source: string): string[] {
  return [...source.matchAll(/\bfailed=\{([^}]*)\}/g)]
    .map((m) => FAILED_EXPRESSION.exec(m[1] ?? '')?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => `set${id.charAt(0).toUpperCase()}${id.slice(1)}`);
}

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
/**
 * 報告先の描画を**排他の枝の内側**に置いてよい state (#968 レビュー M-3)。**理由を必ず書く。**
 *
 * 入れ子そのものが悪いのではなく、**その state が立つ状況で外側の条件が偽になる**のが悪い。
 * 到達可能性は静的走査で取れないので、人が読んで書き、機械は**黙って増えないこと**を守る。
 */
const RENDER_NESTING: readonly { readonly file: string; readonly state: string; readonly why: string }[] = [
  {
    file: 'TenantDetail.tsx',
    state: 'actionError',
    why: 'actionError は「危険な操作」ボタンからしか立たず、そのボタン自体が data の枝の中にある。data は読み取り失敗でも落とさないので、外側の条件は actionError が立つ状況で必ず真',
  },
];

/**
 * 読み取りに失敗したら「読めている」を取り下げる（`readable` を偽へ落とす）配線 (#968 レビュー m-1)。
 */
const CLEAR_ON_READ_FAILURE: readonly {
  readonly file: string;
  readonly fn: string;
  readonly clears: string;
  readonly why: string;
}[] = [
  {
    file: 'ProviderConfig.tsx',
    fn: 'load',
    clears: 'setData(null)',
    why: 'readable = data !== null が保存導線を閉じる唯一の根拠。失敗時に stale な data を残すと、楽観ロックの無い全置換 upsert が有効なまま残る',
  },
];

/**
 * エラー表示が**押しのけてはいけない**表示 (#968 レビュー M-4)。
 *
 * `switchError` を優先順位つき三項の先頭に置いたところ、一度切替に失敗すると
 * `表示中: <name>` と `（選択中と別）`（#423 の越境警告）が**恒久的に消える**ことになった
 * （`switchError` は次の切替まで `null` に戻らない）。切替が成立しなかった直後は
 * 「スコープが変わったつもりで変わっていない」まさにその瞬間で、そこで越境警告を消すのは
 * 方向が逆である。**エラーは併記する。**
 */
const MUST_NOT_DISPLACE: readonly {
  readonly file: string;
  readonly errorState: string;
  readonly testId: string;
  readonly why: string;
}[] = [
  {
    file: 'TenantSwitcher.tsx',
    errorState: 'switchError',
    testId: 'platform-viewing-tenant',
    why: '#423 の越境警告。切替に失敗した直後こそ「選択中と別のテナントを見ている」を出し続ける必要がある',
  },
  {
    file: 'TenantSwitcher.tsx',
    errorState: 'listError',
    testId: 'platform-viewing-tenant',
    why: '同上。一覧が引けないことと、いまどのテナントを見ているかは別の情報',
  },
];

/**
 * 失敗した状態から**画面内で復帰する導線** (#968 レビュー m-4 / m-5)。
 *
 * ガードで操作を塞ぐなら、塞いだ状態から出る道を同じ画面に置く。`load` が
 * `useCallback(…, [])` の画面はマウント時 1 回きりで、再読込の導線が無いと
 * ブラウザのリロードしか道が無い（しかも文言はそれを言わない）。
 */
const RECOVERY_CONTROL: readonly { readonly file: string; readonly testId: string; readonly calls: string }[] = [
  { file: 'ProviderConfig.tsx', testId: 'provider-config-reload', calls: 'void load()' },
  { file: 'FeatureFlags.tsx', testId: 'feature-flags-retry', calls: 'void loadTenantFlags(' },
];

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
          return reportsFailure(body)
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
      const feeders = failedFeeders(f.source);
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
      if (g.guardFirst === true) {
        const firstGuard = guards[0] ?? Number.MAX_SAFE_INTEGER;
        const early = [...body.matchAll(/\bset[A-Z]\w*\s*\(/g)]
          .filter((m) => (m.index ?? 0) < firstGuard)
          .map((m) => `${g.fn}: ${m[0]} が世代ガードより前に在る（古い呼び出しが表示を壊す）`);
        expect(early).toEqual([]);
      }

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
      'FeatureFlags.tsx:toggle',
    ]);
    expect(RESET_ON_SWITCH.map((r) => `${r.file}:${r.setter}`)).toEqual([
      'TenantDetail.tsx:setActionError',
      'FeatureFlags.tsx:setFlagsError',
      'FeatureFlags.tsx:setWriteError',
    ]);
  });

  /*
   * 🔴 **`failed={…}` の式の形を閉じる (#968 レビュー M-2)。**
   * `const readFailed = error !== null;` を 1 つ挟むだけで AC4 の検査が空振りした（実測）。
   */
  it('failed に渡す式は <state> !== null の形（別名で feeder を隠さない）', () => {
    const offenders = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source).flatMap((block) => {
        const testId = /testId="([^"]*)"/.exec(block)?.[1] ?? '(testId なし)';
        if (FAILED_CONSTANT_ALLOWED.includes(testId)) return [];
        const expr = /\bfailed=\{([^}]*)\}/.exec(block)?.[1];
        if (expr === undefined) return [`${f.name}: ${testId} が failed を渡していない`];
        return FAILED_EXPRESSION.test(expr) ? [] : [`${f.name}: ${testId} の failed=${expr}`];
      }),
    );
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: failed を式で渡す DataTable が実在する（形の検査を空虚にしない）', () => {
    expect(platformFiles().flatMap((f) => failedFeeders(f.source)).length).toBeGreaterThanOrEqual(7);
  });

  it('🔴 定数免除は固定（黙って増やせない）', () => {
    expect([...FAILED_CONSTANT_ALLOWED]).toEqual(['aws-cost-breakdown']);
  });

  /*
   * 🔴 **HTTP の失敗も報告する (#968 レビュー M-1)。**
   *
   * 新検出器は「囲む `catch` が報告する」しか要求していなかったので、`!res.ok` の枝で
   * 黙って `return` する形が**構造上見えなかった**。この console で最も起こりやすい失敗は
   * 403（developer 権限・昇格切れ）で、reject（オフライン）より遥かに多い。
   */
  it('!res.ok の枝は失敗を報告する（403 / 5xx を無言にしない）', () => {
    const offenders = platformFiles().flatMap((f) =>
      notOkBranches(f.source).flatMap((b) =>
        reportsFailure(b.body) ? [] : [`${f.name}: if (${b.condition}) が無言`],
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: !res.ok の枝を実際に見つけている（走査が空振りしていない）', () => {
    expect(platformFiles().reduce((n, f) => n + notOkBranches(f.source).length, 0)).toBeGreaterThanOrEqual(8);
  });

  /*
   * 🔴 **報告先の描画が「到達する」ことまで見る (#968 レビュー M-3)。**
   *
   * 「描いている」は正規表現で見えるが、**描画を排他の枝の内側へ移す**と到達しなくなる ——
   * レビューは `{flagsError ? …}` を `{flags ? ( … )}` の中へ移す変異を当てて生存させた
   * （`flagsError` が立つのは `flags === null` のときだけなので、**永遠に描かれない**）。
   * 著者の行列の「描かない」は削除の 1 綴りしか見ていなかった。
   *
   * 静的走査で到達可能性そのものは取れないので、**入れ子を禁じ、例外は理由つきで登録**させる。
   */
  it('報告先の描画は排他の枝の内側に置かない（描くが到達しない形にしない）', () => {
    const offenders = platformFiles().flatMap((f) => {
      /*
       * JSX の条件付きコンテナ `{cond ? …}`。**識別子は `{` と同じ行にあることを要求する**
       * —— `\s*` で改行を跨がせると、コンポーネント関数の本体そのもの（`{` の次の行に
       * `const pathname = usePathname() ?? ''`）が「コンテナ」に化け、**画面全体が
       * 入れ子扱い**になる（実測。`??` の `?` を拾っていた）。`??` も除く。
       */
      const containers = [...f.source.matchAll(/\{[ \t]*[A-Za-z_$][^{}\n]*?(?<!\?)\?(?!\?)/g)]
        .map((m) => ({ start: m.index ?? 0, end: matchBrace(f.source, m.index ?? 0) }))
        .filter((c) => c.end > 0);
      const reported = new Set(
        tryCatchBlocks(f.source).flatMap((b) =>
          reportedStates(f.source.slice(b.catchBody.start, b.catchBody.end)),
        ),
      );
      const conditionOf = (c: { start: number; end: number }): string => {
        const head = (f.source.slice(c.start, c.end).split('\n')[0] ?? '').replace(/^\{/, '');
        return head.slice(0, head.lastIndexOf('?')).trim();
      };
      return [...reported].flatMap((state) => {
        const registered = RENDER_NESTING.some((e) => e.file === f.name && e.state === state);
        /*
         * 🔴 **描画は「その state だけ」を条件にする。**
         *
         * 条件に別の state を and で足す変異（`{flags && flagsError ? …}`）は、
         * 「その state で始まる三項」を探す形だと**検出そのものから外れる**（実測で生存）——
         * `flagsError` が立つのは `flags === null` のときだけなので、描画は永遠に到達しない。
         * 閉じた形 `state` / `state !== null` の描画が**在ること**を先に要求する。
         */
        const renders = containers.filter((c) =>
          new RegExp(`^${state}\\s*(?:!==\\s*null)?$`).test(conditionOf(c)),
        );
        if (renders.length === 0)
          return registered ? [] : [`${f.name}: ${state} を単独条件で描いていない`];
        return renders.flatMap((c) => {
          const enclosing = containers.filter((x) => x.start < c.start && x.end > c.start);
          return enclosing.length > 0 && !registered
            ? [`${f.name}: ${state} の描画が排他の枝の内側に在る`]
            : [];
        });
      });
    });
    expect(offenders).toEqual([]);
  });

  it('🔴 入れ子の免除は理由つきで固定（黙って増やせない）', () => {
    expect(RENDER_NESTING.filter((e) => e.why.trim().length < 10)).toEqual([]);
    expect(RENDER_NESTING.map((e) => `${e.file}:${e.state}`)).toEqual(['TenantDetail.tsx:actionError']);
  });

  /*
   * 🔴 **読めなくなったら「読めている」を取り下げる (#968 レビュー m-1)。**
   *
   * `readable = data !== null` で保存導線を閉じても、失敗時に `data` を落とさなければ
   * **stale なデータで `readable` が真のまま**残り、全置換 upsert の保存ボタンが有効になる。
   * 実描画のオラクル（`list-read-state.test.tsx`）は `useEffect` が走らないため初期状態しか
   * 見られず、「一度読めたあとに読めなくなった」は観測できない。ここが唯一の閂。
   */
  it.each(CLEAR_ON_READ_FAILURE.map((c) => [`${c.file}:${c.fn}`, c] as const))(
    '%s: 読み取りの失敗枝で %s を落とす',
    (_label, target) => {
      const file = platformFiles().find((f) => f.name === target.file);
      const fn = functionBodies(file?.source ?? '').find((b) => b.name === target.fn);
      expect(fn, `${target.file} に ${target.fn} が無い`).toBeDefined();
      const body = fn?.body ?? '';
      const failurePaths = [
        ...[...body.matchAll(/if\s*\([^)]*!res\.ok[^)]*\)\s*\{/g)].map((m) => {
          const open = (m.index ?? 0) + m[0].length - 1;
          return body.slice(open, matchBrace(body, open));
        }),
        ...tryCatchBlocks(body).map((b) => body.slice(b.catchBody.start, b.catchBody.end)),
      ];
      expect(failurePaths.length, '失敗枝が見つからない（登録が腐っている）').toBeGreaterThanOrEqual(2);
      const missing = failurePaths.filter((path) => !path.includes(target.clears));
      expect(missing.length, `${target.clears} を呼ばない失敗枝が在る`).toBe(0);
    },
  );

  it.each(MUST_NOT_DISPLACE.map((d) => [`${d.file}:${d.errorState}`, d] as const))(
    '%s: エラー表示が既存の表示を押しのけない',
    (_label, target) => {
      const file = platformFiles().find((f) => f.name === target.file);
      expect(file, `${target.file} が無い`).toBeDefined();
      const source = file?.source ?? '';
      const at = source.search(
        new RegExp(`\\{[ \\t]*${target.errorState}\\s*(?:!==\\s*null\\s*)?\\?`),
      );
      expect(at, `${target.errorState} の描画が無い`).toBeGreaterThan(-1);
      const end = matchBrace(source, at);
      expect(end, 'ブロックを切り出せない').toBeGreaterThan(at);
      const displaced = source.slice(at, end).includes(target.testId);
      expect(displaced, `${target.testId} が ${target.errorState} の枝の中に在る`).toBe(false);
      // 下界: 押しのけられていないだけでなく、実際に描かれていること。
      expect(source, `${target.testId} が描かれていない`).toContain(target.testId);
    },
  );

  it.each(RECOVERY_CONTROL.map((r) => [`${r.file}:${r.testId}`, r] as const))(
    '%s: 失敗から復帰する導線が画面に在る',
    (_label, target) => {
      const file = platformFiles().find((f) => f.name === target.file);
      expect(file?.source ?? '', `${target.testId} が無い`).toContain(`data-testid="${target.testId}"`);
      expect(file?.source ?? '', `${target.testId} が再取得を呼んでいない`).toContain(target.calls);
    },
  );

  it('🔴 復帰導線と押しのけ禁止の登録簿は固定', () => {
    expect(MUST_NOT_DISPLACE.filter((d) => d.why.trim().length < 10)).toEqual([]);
    expect(RECOVERY_CONTROL.map((r) => r.testId)).toEqual([
      'provider-config-reload',
      'feature-flags-retry',
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
