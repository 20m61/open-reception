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
        combined += readFileSync(candidate, 'utf8');
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
      if (GUARD_MARKERS.some((m) => withLocalImports(file, source).includes(m))) continue;
      if (Object.hasOwn(UNGUARDED_ROUTES, file)) continue;
      unguarded.push(file);
    }
    expect(unguarded, `認可ガードを通していない管理 API: ${unguarded.join(', ')}`).toEqual([]);
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
