import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 管理画面の一覧が「読み込み中 / 失敗 / 0 件」を描き分ける (#966)。
 *
 * ## 何が起きていたか
 *
 * 4 画面（`AssetsManager` / `DepartmentsManager` / `OrganizationsManager` / `StaffManager`）は
 * 一覧を共有 `ui/DataTable` で描いていたが、`loaded` / `failed` を渡していなかった。
 * 一覧の初期値が `useState<T[]>([])` なので**「未読」と「0 件」を型のうえで区別できず**、
 * 取得前も取得失敗も「登録された部署はありません。」と**断定**していた。運用者は「無い」と
 * 信じて操作をやめる。#896 / 課題 06 が platform 側で潰したのと同じ欠陥である。
 *
 * ## platform 側と同じ形にする理由
 *
 * `tests/config/platform-list-states.test.ts` が platform で使っている形
 * （`loaded` と `failed` を**対で**渡す + 定数に束ねない + 下界 + 登録簿の同一性固定）を
 * そのまま広げる。**各画面が自前で書き続ける限り、次に画面を足す人がまた同じ穴を開ける**
 * （`AdminReadGate` #870 の轍）。
 *
 * ## 2 つで 1 組
 *
 * ここはソースの**文字列**を見る。`loaded={items !== null}` → `loaded`（定数 `true`）という
 * **配線の変異**は文字列検査では殺せないので、実描画の観測
 * （`src/components/admin/list-read-state.test.tsx`）と対で使う。逆に `failed` 側は
 * `useEffect` が走らない静的描画では区別できないため、**ここが唯一の閂**である。
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `platform/` を除く管理画面の `.tsx`（テスト除く）。platform 側は別ファイルが縛る。 */
function adminFiles(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'platform') continue;
        walk(path, name);
      } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
        out.push({ name, source: stripComments(readFileSync(path, 'utf8')) });
    }
  };
  walk(ADMIN_DIR, '');
  return out;
}

/**
 * `<DataTable ... />` を粗く切り出す。終端を最初の `/>` で取るので、属性値の中に自己閉じ
 * JSX があると早く切れる。切れたブロックが黙って通らないよう、`testId=` を含むことを別に要求する
 * （#896 レビュー m5 と同じ受け皿）。
 */
function dataTableBlocks(source: string): string[] {
  return [...source.matchAll(/<DataTable\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/**
 * 3 状態を渡すことを要求する一覧 (#966 AC1)。**件数ではなく同一性で固定する。**
 *
 * `>= 4` のような件数では、1 つ外して別の 1 つを足す変異が素通りする
 * （`platform-list-states.test.ts` の `FILES_ALLOWED_RAW_TABLE` と同じ理由）。
 *
 * 🔴 **ここに載っていない一覧が野放しなわけではない。** 管理画面には `loaded`/`failed` を
 * まだ渡していない `DataTable` が他にもあり、それらは #966 の対象外（移行を一度に強制しない
 * という `DataTable` 側の既定に従う）。**新しく状態を渡した一覧は必ずここへ足すこと** ——
 * 下の「網羅」がそれを機械で要求する。
 */
const REQUIRE_READ_STATE: readonly { readonly testId: string; readonly file: string }[] = [
  { testId: 'asset-table', file: 'AssetsManager.tsx' },
  { testId: 'dept-table', file: 'DepartmentsManager.tsx' },
  { testId: 'org-table', file: 'OrganizationsManager.tsx' },
  { testId: 'staff-table', file: 'StaffManager.tsx' },
];

/**
 * 一覧の取得結果を `T[] | null` で持つこと (#966 AC2)。
 *
 * `loaded` を渡していても、state が `useState<T[]>([])` のままだと `loaded` は常に真になり、
 * **3 状態は復活しない**。型で「未読」を表せることまで縛る。
 */
const LIST_STATE_DECLARATION = /useState<\s*[A-Za-z_$][\w$<>, ]*\[\]\s*\|\s*null\s*>\(null\)/;

/** 失敗を**画面へ出す**呼び出し。空値を渡す形は報告と認めない（#968 レビュー B2 と同じ）。 */
const FAILURE_REPORT =
  /\bset[A-Za-z]*(?:Error|Failed|Failure)\s*\(\s*(?!\)|null\s*\)|undefined\s*\)|''\s*\)|""\s*\)|false\s*\))/;

/** 文字列 / テンプレートリテラルの終端。`${}` の入れ子も飛ばす。 */
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

/** `from`（`{` の位置）に対応する `}` の**次**の位置。 */
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

/**
 * `const foo = useCallback(… => { … })` の本体。
 *
 * 🔴 **正規表現で本体の終端を取らない。** 最初は `/\n  \}, \[/` で閉じを探していたが、
 * 依存配列が複数行に折られる（`},\n    [load],\n  );`）と当たらず、**操作系の本体が
 * 1 つも見つからないまま主張が空虚に満たされていた**（実測で生存）。ブレースを数える。
 */
function callbackBodies(source: string): { readonly name: string; readonly body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*useCallback\(/g)) {
    const arrow = source.indexOf('=> {', m.index ?? 0);
    if (arrow < 0) continue;
    const end = matchBrace(source, arrow + 3);
    if (end < 0) continue;
    out.push({ name: m[1] ?? '', body: source.slice(arrow + 3, end) });
  }
  return out;
}

/** `load` の本体。 */
function loadBody(source: string): string | undefined {
  return callbackBodies(source).find((b) => b.name === 'load')?.body;
}

/** `try { … } catch (…) { … }` の catch 本体。 */
function catchBodies(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\btry\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const tryEnd = matchBrace(source, open);
    if (tryEnd < 0) continue;
    const head = /^\s*catch\s*(\([^)]*\)\s*)?\{/.exec(source.slice(tryEnd));
    if (!head) continue;
    const catchOpen = tryEnd + head[0].length - 1;
    const catchEnd = matchBrace(source, catchOpen);
    if (catchEnd < 0) continue;
    out.push(source.slice(catchOpen, catchEnd));
  }
  return out;
}

describe('管理画面の一覧の状態表示 (#966)', () => {
  it('🔴 下界: loaded / failed を対で渡す DataTable が実在する', () => {
    const stateful = adminFiles().flatMap((f) =>
      dataTableBlocks(f.source).filter(
        (b) => /\bloaded[=\s/>]/.test(b) && /\bfailed[=\s]/.test(b),
      ),
    );
    expect(stateful.length).toBeGreaterThanOrEqual(REQUIRE_READ_STATE.length);
  });

  it('切り出した DataTable ブロックは testId を含む（正規表現の早期終端を検出する）', () => {
    const offenders = adminFiles().flatMap((f) =>
      dataTableBlocks(f.source)
        .filter((b) => !/testId=/.test(b))
        .map((b) => `${f.name}: ${b.slice(0, 60)}…`),
    );
    expect(offenders).toEqual([]);
  });

  it.each(REQUIRE_READ_STATE.map((r) => [r.testId, r] as const))(
    '%s は loaded と failed を対で渡す（失敗を「読み込み中」に化けさせない）',
    (_id, target) => {
      const file = adminFiles().find((f) => f.name === target.file);
      expect(file, `${target.file} が無い`).toBeDefined();
      const block = dataTableBlocks(file?.source ?? '').find((b) =>
        b.includes(`testId="${target.testId}"`),
      );
      expect(block, `${target.testId} の DataTable が無い`).toBeDefined();
      expect(block ?? '', 'loaded を渡していない').toMatch(/\bloaded=\{/);
      expect(block ?? '', 'failed を渡していない').toMatch(/\bfailed=\{/);
    },
  );

  /*
   * 🔴 **定数に束ねない（#896 レビュー M1 と同じ変異）。**
   * 「対で渡している」は文字列検査なので、`loaded={items !== null}` → `loaded`、
   * `failed={listError !== null}` → `failed={false}` で満たせてしまう。
   */
  it.each(REQUIRE_READ_STATE.map((r) => [r.testId, r] as const))(
    '%s の loaded / failed は定数ではなく状態に由来する式',
    (_id, target) => {
      const file = adminFiles().find((f) => f.name === target.file);
      const block = dataTableBlocks(file?.source ?? '').find((b) =>
        b.includes(`testId="${target.testId}"`),
      );
      expect(block ?? '', 'loaded が定数').toMatch(/\bloaded=\{(?!true\}|false\})/);
      expect(block ?? '', 'failed が定数').toMatch(/\bfailed=\{(?!true\}|false\})/);
    },
  );

  /*
   * 🔴 **型で「未読」を表せること (#966 AC2)。**
   * `loaded={items !== null}` と書いてあっても、state が `useState<T[]>([])` なら
   * `items !== null` は常真 —— 3 状態は復活しない。**配線ではなく型**を縛る。
   */
  it.each(REQUIRE_READ_STATE.map((r) => [r.file, r] as const))(
    '%s は一覧を T[] | null で持つ（[] 初期化に戻さない）',
    (_f, target) => {
      const file = adminFiles().find((f) => f.name === target.file);
      expect(file?.source ?? '', '一覧の state が T[] | null ではない').toMatch(
        LIST_STATE_DECLARATION,
      );
    },
  );

  /*
   * 🔴 **読み取りの失敗を握り潰さない (#966 AC3)。**
   * `DepartmentsManager` / `StaffManager` は `.catch(() => null)` を持つが、それは
   * **操作系（追加・切替・並べ替え）**のためのもので、読み取りは素の `await fetch` だった。
   * `load` の中に限って、失敗を報告する `catch` を要求し、`.catch(` での握り潰しを禁じる。
   */
  it.each(REQUIRE_READ_STATE.map((r) => [r.file, r] as const))(
    '%s の load は失敗を報告する catch を持つ',
    (_f, target) => {
      const file = adminFiles().find((f) => f.name === target.file);
      const body = loadBody(file?.source ?? '');
      expect(body, `${target.file} に load が無い`).toBeDefined();
      expect(body ?? '', 'load が fetch を持たない（登録が腐っている）').toContain('fetch(');
      /*
       * 🔴 **`catch` の中身そのものを見る。** `load` 全体で `FAILURE_REPORT` を探すと、
       * `if (!res.ok)` 枝の報告で満たされてしまい、**catch の中身を `void 0;` や
       * `setListError('')` に置換する変異が素通りする**（実測で生存）。#968 レビュー B2 と
       * 同じ根（呼び出し名だけを見て引数と位置を見ていない）。
       */
      const catches = catchBodies(body ?? '');
      expect(catches.length, 'load に catch が無い').toBeGreaterThan(0);
      const silent = catches.filter((c) => !FAILURE_REPORT.test(c));
      expect(silent, 'catch が失敗を報告していない').toEqual([]);
      expect(body ?? '', '読み取りを .catch( で握り潰している').not.toMatch(/\.catch\s*\(/);
    },
  );

  /*
   * 🔴 **操作の失敗が一覧を「読み込めませんでした」に化けさせない (#968 AC4 の管理画面版)。**
   * `failed` を決める state に、`method:` を持つ本体（＝操作系）が書かないこと。
   */
  it('操作の失敗は読み取りの失敗と別の state に載せる', () => {
    const offenders = adminFiles().flatMap((f) => {
      const feeders = dataTableBlocks(f.source)
        .flatMap((b) => [...b.matchAll(/\bfailed=\{([^}]*)\}/g)].map((m) => m[1] ?? ''))
        .flatMap((expr) =>
          [...expr.matchAll(/[A-Za-z_$][\w$]*/g)]
            .map((m) => m[0])
            .filter((id) => !['Boolean', 'null', 'undefined', 'true', 'false'].includes(id))
            .map((id) => `set${id.charAt(0).toUpperCase()}${id.slice(1)}`),
        );
      if (feeders.length === 0) return [];
      const mutating = callbackBodies(f.source).filter((fn) =>
        /method:\s*['"`](PATCH|POST|PUT|DELETE)/.test(fn.body),
      );
      return mutating.flatMap((fn) =>
        [...new Set(feeders)]
          .filter((setter) => fn.body.includes(`${setter}(`))
          .map((setter) => `${f.name}: ${fn.name} が読み取りの ${setter} を呼んでいる`),
      );
    });
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **下界。** 直上は「操作系の本体を 1 つも見つけられない」と空虚に満たせる。
   * 実際、最初の実装は依存配列が複数行に折られた `useCallback` を取り逃がしており、
   * **保存の失敗を読み取りの state へ載せ直す変異が生存した**（実測）。
   */
  it('🔴 下界: 操作系の本体を実際に見つけている（走査が空振りしていない）', () => {
    const mutating = adminFiles().flatMap((f) =>
      callbackBodies(f.source).filter((fn) => /method:\s*['"`](PATCH|POST|PUT|DELETE)/.test(fn.body)),
    );
    expect(mutating.length).toBeGreaterThanOrEqual(8);
  });

  /*
   * 🔴 **登録簿を固定する（黙って外せない・黙って増やせない）。**
   * 状態を渡した一覧が登録簿の外に生えると、実描画の観測
   * （`src/components/admin/list-read-state.test.tsx` の `LISTS`）にも載らないまま通る。
   */
  it('🔴 網羅: loaded / failed を渡す DataTable は全部 REQUIRE_READ_STATE に載っている', () => {
    const covered = new Set(REQUIRE_READ_STATE.map((r) => r.testId));
    const wired = adminFiles().flatMap((f) =>
      dataTableBlocks(f.source)
        .filter((b) => /\bloaded[=\s/>]/.test(b) && /\bfailed[=\s]/.test(b))
        .map((b) => /testId="([^"]*)"/.exec(b)?.[1] ?? '(testId なし)'),
    );
    expect(wired.filter((t) => !covered.has(t)), 'この一覧を登録簿へ足すこと').toEqual([]);
  });

  it('🔴 登録簿は固定（黙って減らせない）', () => {
    expect(REQUIRE_READ_STATE.map((r) => r.testId)).toEqual([
      'asset-table',
      'dept-table',
      'org-table',
      'staff-table',
    ]);
  });
});
