/**
 * 管理 API の認可ガード網羅の静的検証 (issue #423 / `.claude/rules/admin-api-authz.md`)。
 *
 * **なぜ静的検査か**: 既存の `legacy-routes-guard.test.ts` はルートを**手で列挙**している。
 * 新しい admin API を足しても列挙に入らなければ誰も気づかず、**認可ガードを通さないルートが
 * 静かに増える**。CJK allowlist（#327）・admin ナビ（#421）で踏んだのと同じ形で、しかも
 * こちらは認可境界なので影響が重い。
 *
 * ここでは `src/app/api/{admin,platform}/**` の全ルートを走査し、エクスポートしている
 * HTTP メソッドハンドラが**認可の入口を通っているか**をソース上で確かめる。
 * 「テストが在るか」ではなく「**ガードを参照しているか**」を見るのは、テストは後から
 * 消せてもガードの参照が消えれば動作が壊れるため（規約が要求する性質そのものに近い）。
 *
 * 例外は `UNGUARDED_ROUTES` に理由付きで登録する。理由が薄いものは落ちる。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 認可の入口とみなす識別子。いずれかを参照していればガード経路に乗っている。 */
const GUARD_MARKERS = [
  'requireActor',
  'assertCanRead',
  'assertCanWrite',
  'assertCanReadSite',
  'assertCanWriteSite',
  'authorizePlatform',
  'resolveAdminActor',
  'canEnterArea',
  // platform 側の JIT 昇格ゲートと危険操作ヘルパ（内部で actor を解決する）。
  'assertElevated',
  'handlePlatformDangerCreate',
] as const;

/**
 * **意図的にガードを通さない**ルートと理由。
 *
 * 認可境界の穴になるので、ここへ足すときは「なぜ未認証で叩けてよいか」を書くこと。
 */
const UNGUARDED_ROUTES: Record<string, string> = {
  'src/app/api/admin/login/route.ts': 'ログインの入口。認証を得るための経路なので認証は要求できない',
  'src/app/api/admin/logout/route.ts': 'セッション cookie の破棄のみ。失敗しても情報は出ない',
  'src/app/api/admin/auth/entra/start/route.ts':
    'OIDC 認可要求の開始。IdP へリダイレクトするだけで、まだ actor が存在しない',
  'src/app/api/admin/auth/entra/callback/route.ts':
    'OIDC コールバック。ここで actor を作る側なので、事前の actor 解決はできない',
  'src/app/api/admin/health/route.ts':
    'admin namespace の死活のみ。テナント情報も PII も返さない（appName と status だけ）',
};

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      routeFiles(path, found);
      continue;
    }
    if (entry.name === 'route.ts') found.push(path);
  }
  return found;
}

/**
 * ルートが import している**ローカルモジュールのソース**を 1 段だけ集める。
 *
 * ガードを route に直書きせず、`./authz` のような小さなヘルパへ切り出しているルートが在る
 * （`api/admin/integrations/*`）。マーカーを route 本体だけで探すと、それらを「ガード無し」と
 * 誤判定する。**「無い」と判定する前に、実際にそのモジュールを開く。**
 */
/**
 * コメントを落とす。
 *
 * **doc コメントがガードの代わりになってはいけない。** この検査はソースを文字列走査するので、
 * `requireActor` と書いた doc コメントが在るだけで「ガードを参照している」と判定されていた。
 * 実際、認可ガードを 1 行も持たない route が本検査を通ることを実測した（#373 増分 5）。
 * 規約を説明するコメントほど識別子を書くので、**ガードの説明が丁寧な route ほど素通りする**
 * という逆向きの穴になっていた。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * そのモジュールがガード関数を**定義**しているか（＝呼び出し側ではない）。
 *
 * 動的な `new RegExp` を避けて文字列一致で書く。マーカ名は固定配列由来で外部入力は
 * 到達しないが、抑制コメントを足すより regex を使わない方が素直（SAST の指摘も消える）。
 */
/**
 * `name` が**呼ばれている**か（import されているだけでは false）。
 *
 * ジェネリック引数を挟む呼び出し（`handlePlatformDangerCreate<A, B>(...)`）を取りこぼさない。
 * また `authorizePlatform` を探して `authorizePlatformWithIdentity` に当たらないよう、
 * 前後が識別子文字でないことを確かめる（別関数を「呼んでいる」と誤認しない）。
 */
function callsFunction(source: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = source.indexOf(name, from);
    if (at === -1) return false;
    from = at + name.length;
    if (/[A-Za-z0-9_$.]/.test(source[at - 1] ?? '')) continue;
    let rest = source.slice(from);
    if (rest.startsWith('<')) {
      const close = rest.indexOf('>(');
      if (close === -1) continue;
      rest = rest.slice(close + 1);
    }
    if (rest.startsWith('(')) return true;
  }
}

function definesGuard(source: string): boolean {
  const decls = (m: string) => [
    `export function ${m}`,
    `export async function ${m}`,
    `export const ${m}`,
  ];
  return GUARD_MARKERS.some((m) =>
    decls(m).some((decl) => {
      const at = source.indexOf(decl);
      if (at === -1) return false;
      // 後続が識別子文字なら別名（`requireActorSomething`）。取り違えない。
      return !/[A-Za-z0-9_$]/.test(source[at + decl.length] ?? '');
    }),
  );
}

function withLocalImports(file: string, source: string): string {
  let combined = source;
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
    const spec = match[1];
    if (!spec) continue;
    const path = spec.startsWith('@/')
      ? join('src', spec.slice(2))
      : spec.startsWith('.')
        ? join(file, '..', spec)
        : null;
    if (path === null) continue;
    for (const candidate of [`${path}.ts`, join(path, 'index.ts')]) {
      try {
        const imported = readFileSync(candidate, 'utf8');
        // **ガードを「定義している」モジュールは連結しない。**
        //
        // 連結の目的は「route が委譲した先でガードしている」場合を拾うこと。しかし
        // `@/lib/admin/guard` からは `toGuardResponse`（エラー整形だけの関数）も import する。
        // 全文を連結すると、そこに在る `requireActor` の**定義**が識別子として拾われ、
        // **ガードを 1 行も呼ばない route が本検査を通る**。実測で確認した（#373 増分 5）。
        // 委譲先ヘルパはガードを**呼ぶ**ので、定義側だけ落とせば検出力は落ちない。
        if (!definesGuard(imported)) combined += imported;
        break;
      } catch {
        // 解決できない import（型のみ・存在しない）は無視する。
      }
    }
  }
  return combined;
}

/** ルートが公開している HTTP メソッド。 */
function exportedMethods(source: string): string[] {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  return methods.filter((m) =>
    // `m` は直上の固定リテラル配列の要素のみで、外部入力は到達しない（ReDoS 不成立）。
    // 走査対象もリポジトリ内のソースファイル。
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b`).test(
      source,
    ),
  );
}

describe('管理 API は例外なく認可ガードを通る', () => {
  const files = [
    ...routeFiles('src/app/api/admin'),
    ...routeFiles('src/app/api/platform'),
  ].sort();

  it('走査対象のルートが存在する（glob が壊れて 0 件 green になるのを防ぐ）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('全ルートがガードを参照しているか、理由付きで例外登録されている', () => {
    const unguarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (exportedMethods(source).length === 0) continue;
      const scanned = stripComments(withLocalImports(file, source));
      if (GUARD_MARKERS.some((m) => scanned.includes(m))) continue;
      if (Object.hasOwn(UNGUARDED_ROUTES, file)) continue;
      unguarded.push(file);
    }
    expect(unguarded, `認可ガードを通していない管理 API: ${unguarded.join(', ')}`).toEqual([]);
  });

  /**
   * **書き込みは「認証済み」では足りない** (#595)。
   *
   * 上の検査は `GUARD_MARKERS` のどれか 1 つを参照していれば通す。しかし
   * `resolveAdminTenantId`（ほぼ全ての admin route が呼ぶ）が内部で `requireActor` を
   * 呼ぶため、**テナントを解決する route は自動的に「ガードあり」判定になる**。
   * 結果、`assertCanWrite` を書き忘れた更新系 route が素通りする ＝ 読み取り専用の actor が
   * 書ける穴に気づけない。`.claude/rules/admin-api-authz.md` が要求しているのは認証ではなく
   * **認可**なので、更新系には書き込み判定を要求する。
   *
   * ## 委譲パターンを認める
   *
   * 本リポジトリの更新系には 2 つの正当な形がある。
   *
   * 1. route 内で `assertCanWrite` 等を呼ぶ
   * 2. `actor` を**サービスへ渡し、サービス側が `authorize(actor, …, 'write')` する**
   *
   * 2 を機械的に「認可なし」と断じると誤検出になる（2026-08-02 の監査で 67 route を
   * 全数確認し、**穴はゼロ・33 route が 2 の形**だった）。そこで、認可することを
   * **実際に確認したサービス**を列挙し、そのいずれかへ委譲していれば通す。
   *
   * ## 新しいサービスを足すときは、ここへの追記が要る
   *
   * それが狙い。無自覚に「どちらでもない更新系 route」が増えるのを構造的に止める。
   * 追記する前に、そのサービスが本当に `'write'` で認可しているか確かめること。
   */
  const WRITE_MARKERS = [
    'assertCanWrite',
    'assertCanWriteSite',
    'authorizePlatform',
    'assertElevated',
    'handlePlatformDangerCreate',
    // `authorizePlatform` とは別関数。前方一致では拾えないので明示する。
    'authorizePlatformWithIdentity',
    // integrations 配下のローカルヘルパ。`canAccessTenant(actor, tenantId, op)` を行う。
    'authorize',
  ];

  /**
   * `actor` を受け取り `'write'` で認可することを**確認済み**のサービス生成子。
   * 確認日 2026-08-02（#595 の全数監査）。
   */
  const AUTHORIZING_SERVICES = [
    'getSiteService',
    'getDeviceService',
    'getRoutingService',
    'getSignageService',
    'getStayService',
    'getReceptionFlowService',
    'getStaffResponseConfigService',
    'getCallRouteService',
    'getReservationService',
    'getExperienceVersionService',
  ];

  it('更新系メソッドを公開するルートは書き込み認可を経ている', () => {
    const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!exportedMethods(source).some((m) => WRITE_METHODS.includes(m))) continue;
      if (Object.hasOwn(UNGUARDED_ROUTES, file)) continue;
      // **route 自身のソースだけ**を見る。import 先を連結すると、上の検査と同じ経路で
      // 他人のガードを借りてしまう。
      const own = stripComments(source);
      if (WRITE_MARKERS.some((m) => callsFunction(own, m))) continue;
      if (AUTHORIZING_SERVICES.some((svc) => callsFunction(own, svc))) continue;
      missing.push(file);
    }
    expect(
      missing,
      `書き込み認可を経ていない更新系 API: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('例外の理由が空文字で誤魔化されていない', () => {
    for (const [file, reason] of Object.entries(UNGUARDED_ROUTES)) {
      expect(reason.length, `${file} の例外理由`).toBeGreaterThan(10);
    }
  });

  it('例外リストに実在しないルートが残っていない', () => {
    for (const file of Object.keys(UNGUARDED_ROUTES)) {
      expect(files, `${file} は実在しない`).toContain(file);
    }
  });
});
