import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **拠点一覧の取得状態を捨てる画面を作らせない** (#554 M3)。
 *
 * `useSiteList` は `status`（`loading`/`ready`/`error`）を持つのに、受け取り側が捨てると
 * **取得失敗が「拠点が 1 つも無い」と同じ見た目**になる。#536 で `SiteDetail` に対して
 * 直したのに、`SitesManager` には同じ穴が残っていた — 本リポジトリが繰り返している
 * 「ある画面で解いた対策を別の画面へ写していない」形そのもの。
 *
 * 規律では抜けるので、実ファイルを走査して機械的に落とす
 * （`admin-site-context.test.ts` / `admin-tenant-scope.test.ts` と同じ考え方）。
 */

const ADMIN_COMPONENTS_DIR = resolve(process.cwd(), 'src/components/admin');

/**
 * `const { ... } = useSiteList(` / `useSiteScope(` の**分割代入そのもの**を見る。
 *
 * ソース全体を `/status/` で grep する形にはしない。`SitesManager` には `filterStatus` や
 * `s.status`（拠点の稼働状態）が在るので、**一覧の取得状態を捨てていても緑になる**
 * ＝宣言に対して何も検出しない検査になる（#552 レビュー P2 で同じ失敗をしている）。
 */
const HOOK_DESTRUCTURING = /const\s*\{([^}]*)\}\s*=\s*useSite(?:List|Scope)\s*\(/g;

/** 取得状態を受け取る名前。`useSiteList` は `status`、`useSiteScope` は `listStatus`。 */
const STATUS_BINDING = /(^|,)\s*(status|listStatus)\s*(:|,|$)/;

/** 取り直しを受け取る名前。 */
const RELOAD_BINDING = /(^|,)\s*(reload|reloadSites)\s*(:|,|$)/;

/**
 * **自前の再試行 UI を持たなくてよい消費者**（理由付き）。
 *
 * 増えたら落とすために列挙する（黙らせるためではない）。
 */
const RETRY_NOT_APPLICABLE: readonly { file: string; reason: string }[] = [
  {
    file: 'SiteContextChip.tsx',
    // ヘッダのチップは表示専用で、押せる場所を持たない。本文側の再試行が
    // `invalidateSiteList` で全インスタンスへ配られるので、チップもそれで取り直る。
    reason: 'ヘッダの表示専用チップ。本文の再試行に追随する',
  },
];

function adminComponents(): { file: string; name: string; src: string }[] {
  return readdirSync(ADMIN_COMPONENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
    .map((e) => {
      const file = resolve(ADMIN_COMPONENTS_DIR, e.name);
      return { file, name: e.name, src: readFileSync(file, 'utf8') };
    });
}

/** その component が拠点一覧フックから受け取っている名前（複数呼び出しは結合する）。 */
function siteListBindings(src: string): string | null {
  const matches = [...src.matchAll(HOOK_DESTRUCTURING)].map((m) => m[1]);
  return matches.length === 0 ? null : matches.join(',');
}

const CONSUMERS = adminComponents()
  .map((c) => ({ ...c, bindings: siteListBindings(c.src) }))
  .filter((c): c is typeof c & { bindings: string } => c.bindings !== null);

describe('拠点一覧の取得状態の消費 (#554)', () => {
  it('走査が空振りしていない', () => {
    // 0 件になれば「常に緑」の無意味な検査になる。現状の消費者は
    // 6 マネージャ + SitesManager + SiteDetail + SiteContextChip。
    expect(CONSUMERS.length).toBeGreaterThanOrEqual(9);
  });

  it('一覧を取りに行く画面は取得状態を受け取っている', () => {
    const dropped = CONSUMERS.filter((c) => !STATUS_BINDING.test(c.bindings)).map((c) => c.name);
    expect(dropped, '取得失敗が「拠点が 0 件」と同じ見た目になる').toEqual([]);
  });

  it('一覧を取りに行く画面は取り直しの導線を持っている', () => {
    // 一覧が取れないと拠点別画面は `scopeReady` が立たず、その画面は何も取得できず
    // 何も保存できない。画面全体のリロード以外に復帰手段が無い状態を作らない。
    const exempt = new Set(RETRY_NOT_APPLICABLE.map((e) => e.file));
    const stuck = CONSUMERS.filter(
      (c) => !exempt.has(c.name) && !RELOAD_BINDING.test(c.bindings),
    ).map((c) => c.name);
    expect(stuck, '取得失敗から復帰する手段が無い').toEqual([]);
  });

  it('再試行の免除リストが腐っていない', () => {
    for (const { file } of RETRY_NOT_APPLICABLE) {
      const consumer = CONSUMERS.find((c) => c.name === file);
      // 一覧を取らなくなった component が免除として残り続けない。
      expect(consumer, `${file} はもう拠点一覧を取っていないので免除から外す`).toBeDefined();
      // 自前の再試行を持ったのに免除に残っている。
      expect(
        RELOAD_BINDING.test(consumer?.bindings ?? ''),
        `${file} は再試行を持っているので免除から外す`,
      ).toBe(false);
    }
  });

  it('検出器が本当に落ちる（取得状態を捨てた形を緑にしない）', () => {
    // 検出器そのものの検査。ソース全体を grep する実装だと、`filterStatus` のような
    // 無関係な名前で緑になってしまう（それでは宣言を守れない）。
    const droppedStatus = 'const { sites, reload } = useSiteList(tenantId);\nconst filterStatus = 1;';
    expect(STATUS_BINDING.test(siteListBindings(droppedStatus) ?? '')).toBe(false);

    const keptStatus = 'const { sites, status, reload } = useSiteList(tenantId);';
    expect(STATUS_BINDING.test(siteListBindings(keptStatus) ?? '')).toBe(true);

    const renamed = 'const { sites, status: listStatus, reload } = useSiteList(tenantId);';
    expect(STATUS_BINDING.test(siteListBindings(renamed) ?? '')).toBe(true);
  });
});

/**
 * **共有の門を使う画面は、自画面の取得失敗から復帰できること** (#554 レビュー M3)。
 *
 * `SiteScopeSelect` の「再試行」は**拠点一覧**の失敗にしか出ない。拠点一覧は正常で
 * その画面の GET だけが 401/403/5xx のとき、`canRefresh` を消費していない画面は
 * **押せるものが 1 つも無くなり、ブラウザリロードしか復帰手段が残らない**。
 * `scope-gate.ts` がわざわざ `canRefresh` を用意しているのに 4 画面中 3 画面が
 * 捨てていた（＝この repo が繰り返す「別の画面へ写していない」型）ので機械で止める。
 */
describe('取得失敗からの復帰導線 (#554)', () => {
  /**
   * 共有の門の利用者。直接使う形と、画面固有の文言を足すラッパ経由の形がある
   * （`stay/scope-actions.ts` が後者）。ラッパを足したらここへ追記する。
   */
  const USES_GATE = /resolveScopeGate\(|resolveStayScopeActions\(/;
  const GATE_USERS = adminComponents().filter((c) => USES_GATE.test(c.src));

  it('走査が空振りしていない', () => {
    expect(GATE_USERS.length).toBeGreaterThanOrEqual(4);
  });

  it('共有の門を使う画面は canRefresh を消費している', () => {
    const dropped = GATE_USERS.filter((c) => !/canRefresh/.test(c.src)).map((c) => c.name);
    expect(dropped, '自画面の取得失敗から復帰する手段が無い').toEqual([]);
  });

  it('共有の門を使う画面は取得できない理由を出し分けている', () => {
    // 失敗を「読み込み中…」と出すと、運用者は終わらない待ちに入る。
    // ラッパ経由の画面は文言をラッパ側で決めており、その分岐は
    // `stay/scope-actions.test.ts` が固定している。
    const dropped = GATE_USERS.filter(
      (c) => !/\.unavailable|resolveStayScopeActions\(/.test(c.src),
    ).map((c) => c.name);
    expect(dropped, '取得できない理由を伝えていない').toEqual([]);
  });
});

describe('拠点一覧の取得に締切がある (#554 N8)', () => {
  it('fetch に AbortSignal を渡している', () => {
    // 締切が無いと、応答が返らないときだけ `error` にすら遷移できず、
    // `status` は `loading` のまま固まる（＝再試行にも辿り着けない）。
    const src = readFileSync(resolve(ADMIN_COMPONENTS_DIR, 'use-site-list.ts'), 'utf8');
    expect(src).toContain('AbortController');
    expect(src).toMatch(/signal:\s*\w+\.signal/);
  });
});
