/**
 * Playwright project の testMatch / testIgnore を、resolver を介さず評価する (#818)。
 *
 * Playwright の実 resolver は glob 展開・依存 project・grep を含むため、
 * 「この spec はどの project で走るか」をテストから観測すると環境依存になる。
 * 文字列 matcher は Playwright 本体と同じ createFileMatcher（glob + 絶対パス）で
 * 評価する。隔離 project を足すときに 2 箇所（testMatch と DEFAULT_TEST_IGNORE）を
 * 協調編集し忘れると、ここで 0 件または 2 件になって落ちる。
 *
 * `soak/` は `playwright.soak.config.ts` 専用なので、本設定ではどの project にも
 * 載せない（0 件）のが正しい。
 *
 * platform- 接頭辞の spec と capture-screens-platform は platform-developer
 * project 専用。PLAYWRIGHT_BASE_URL 指定時はその project 自体が落ちるので、
 * 0 件が正しい（走らせても admin へリダイレクトされて必ず落ちる）。
 */
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
/** Playwright 本体と同じ matcher。文字列 glob は先頭が globstar でなければ prepend する。 */
const { createFileMatcher } = require('playwright/lib/util') as {
  createFileMatcher: (patterns: unknown) => (filePath: string) => boolean;
};

export type E2eProjectSlice = {
  name: string;
  testMatch?: unknown;
  testIgnore?: unknown;
  dependencies?: readonly string[];
};

/** testDir からの相対 POSIX パス（例: `kiosk-flow-integration.spec.ts`, `soak/foo.spec.ts`）。 */
export type SpecRelPath = string;

function asPatterns(pattern: unknown): Array<RegExp | string> {
  if (pattern == null) return [];
  const list = Array.isArray(pattern) ? pattern : [pattern];
  return list.filter((p): p is RegExp | string => p instanceof RegExp || typeof p === 'string');
}

/**
 * Playwright の `createFileMatcher` は正規表現を **filePath（絶対パス）** に当てる
 * （`playwright/lib/util.js`）。testDir 相対の `soak/foo.spec.ts` には `/\/soak\//` が
 * 当たらない。合成パスに `/tests/e2e/` を含めて、本体と同じ意味論にする。
 */
export function playwrightStyleFilePath(specRelPath: SpecRelPath): string {
  const posix = specRelPath.replaceAll('\\', '/');
  return `/repo/tests/e2e/${posix}`;
}

export function patternMatchesSpec(pattern: unknown, specRelPath: SpecRelPath): boolean {
  const patterns = asPatterns(pattern);
  if (patterns.length === 0) return false;
  return createFileMatcher(patterns)(playwrightStyleFilePath(specRelPath));
}

/**
 * 1 project がこの spec を実行対象にするか。
 *
 * - `testMatch` が無い → Playwright 既定どおり testDir 配下の spec を対象（ignore のみ効く）
 * - `testMatch` がある → それに当たるものだけ
 * - `testIgnore` に当たれば除外
 */
export function projectOwnsSpec(project: E2eProjectSlice, specRelPath: SpecRelPath): boolean {
  if (patternMatchesSpec(project.testIgnore, specRelPath)) return false;
  if (project.testMatch == null) return true;
  return patternMatchesSpec(project.testMatch, specRelPath);
}

/**
 * webkit の iPad project は chromium と同じ spec を意図的に二度走る（`E2E_WEBKIT=1` / CI）。
 * #818 が止めるのは「隔離を忘れて chromium-ipad と専用 project の両方で走る」ことなので、
 * クロスブラウザ複製は所有カウントから外す。
 */
export function isCrossBrowserReplicaProject(name: string): boolean {
  return name === 'ipad-landscape' || name === 'ipad-portrait';
}

export function owningProjectNames(
  specRelPath: SpecRelPath,
  projects: readonly E2eProjectSlice[],
): string[] {
  return projects.filter((p) => projectOwnsSpec(p, specRelPath)).map((p) => p.name);
}

/**
 * Playwright 既定の testMatch（spec / test × js/ts 系拡張子）。
 * config にグローバル testMatch が無いので、走査側も本体と同じ拡張子を拾う。
 */
const PLAYWRIGHT_DEFAULT_TEST_FILE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

export function isPlaywrightDiscoveredTestFile(fileName: string): boolean {
  return PLAYWRIGHT_DEFAULT_TEST_FILE.test(fileName);
}

/** `tests/e2e` 配下の Playwright 発見対象ファイルを testDir 相対パスで列挙する。 */
export function listE2eSpecRelPaths(testDir: string): SpecRelPath[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else if (isPlaywrightDiscoveredTestFile(name)) out.push(childRel);
    }
  };
  walk(testDir, '');
  return out.sort();
}

export function isSoakSpec(specRelPath: SpecRelPath): boolean {
  return specRelPath.split('/').includes('soak');
}

/**
 * `playwright.config.ts` の `PLATFORM_SPECS` と同じ命名。
 * developer 専用サーバ向けで、remote 実行では project ごと落ちる。
 */
const PLATFORM_SPEC_BASENAME = /^(platform-[a-z0-9-]+|capture-screens-platform)\.spec\.ts$/;

export function isPlatformSpec(specRelPath: SpecRelPath): boolean {
  const base = specRelPath.replaceAll('\\', '/').split('/').pop() ?? specRelPath;
  return PLATFORM_SPEC_BASENAME.test(base);
}

export function hasPlatformDeveloperProject(projects: readonly E2eProjectSlice[]): boolean {
  return projects.some((p) => p.name === 'platform-developer');
}

/**
 * soak / remote-platform を折り込んだ所有違反。空配列なら不変条件を満たす。
 */
export function collectOwnershipViolations(
  specs: readonly SpecRelPath[],
  projects: readonly E2eProjectSlice[],
): string[] {
  const counted = projects.filter((p) => !isCrossBrowserReplicaProject(p.name));
  const platformProjectPresent = hasPlatformDeveloperProject(counted);
  const violations: string[] = [];
  for (const spec of specs) {
    const owners = owningProjectNames(spec, counted);
    if (isSoakSpec(spec)) {
      if (owners.length !== 0) {
        violations.push(`${spec}: soak なのに ${owners.join(',')}`);
      }
      continue;
    }
    if (isPlatformSpec(spec) && !platformProjectPresent) {
      if (owners.length !== 0) {
        violations.push(`${spec}: platform-developer 不在なのに ${owners.join(',')}`);
      }
      continue;
    }
    if (owners.length !== 1) {
      violations.push(`${spec}: ${owners.length === 0 ? 'どこにも載っていない' : owners.join(',')}`);
    }
  }
  return violations;
}

/**
 * **同居者 0 で走らなければならない終端 project** (#787 / #1161)。
 *
 * グローバル状態（在席状態・既定スコープのフロー・セキュリティ設定）を書き換える spec の置き場。
 * `fullyParallel` は config 全体に効くので、project を分けても**その中では並行実行される**。
 * ここに載せた project は (1) spec をちょうど 1 本だけ持ち、(2) 自分と並行しうる project を
 * 持たない（他の全 project が自分の祖先か子孫）ことを要求する。
 */
export const SOLO_TERMINAL_PROJECTS = [
  'flow-mutation-kiosk',
  'staff-availability-mutation',
  'security-settings-mutation',
] as const;

/**
 * 並行して走っても状態を共有しない project。`platform-developer` は**別プロセスの別サーバ**
 * （別ポート・メモリ上の状態も別）へ向くので、依存を持たずに並行してよい（playwright.config.ts）。
 */
const SEPARATE_SERVER_PROJECTS = new Set(['platform-developer']);

function transitiveDependencies(name: string, byName: ReadonlyMap<string, E2eProjectSlice>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byName.get(name)?.dependencies ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byName.get(next)?.dependencies ?? []));
  }
  return seen;
}

/**
 * 終端 project の同居者・並行者の違反。空配列なら不変条件を満たす。
 *
 * - spec が 0 本 → 隔離先が空（testMatch の書き忘れ、または spec の改名で外れた）
 * - spec が 2 本以上 → 同居者がいる（#787 で実際に 4 回中 2 回落ちた形）
 * - 依存で前後が決まっていない project がある → project 同士で並行する
 */
export function collectSoloProjectViolations(
  specs: readonly SpecRelPath[],
  projects: readonly E2eProjectSlice[],
  soloNames: readonly string[] = SOLO_TERMINAL_PROJECTS,
): string[] {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const violations: string[] = [];
  for (const solo of soloNames) {
    const project = byName.get(solo);
    if (!project) {
      violations.push(`${solo}: project が無い`);
      continue;
    }
    const owned = specs.filter((spec) => projectOwnsSpec(project, spec));
    if (owned.length !== 1) {
      violations.push(
        `${solo}: spec は 1 本だけのはずが ${owned.length} 本${owned.length > 0 ? `（${owned.join(', ')}）` : ''}`,
      );
    }
    const ancestors = transitiveDependencies(solo, byName);
    for (const other of projects) {
      if (other.name === solo || SEPARATE_SERVER_PROJECTS.has(other.name)) continue;
      if (ancestors.has(other.name)) continue;
      if (transitiveDependencies(other.name, byName).has(solo)) continue;
      violations.push(`${solo}: ${other.name} と依存で前後が決まっておらず並行しうる`);
    }
  }
  return violations;
}

/**
 * **実サーバのセキュリティ設定へ書き込む**呼び出し（`page.request.put('/api/admin/security', …)` 等）。
 * `page.route` で書き込みを注入して落とす spec（`admin-write-failure`）は当たらない。
 */
const SECURITY_SETTINGS_WRITE = /request\.(put|post|patch|delete)\(\s*["'`]\/api\/admin\/security(?=["'`?\/])/;

export function writesSecuritySettings(source: string): boolean {
  return SECURITY_SETTINGS_WRITE.test(source);
}

/**
 * 書き換える spec の後始末の形 (#1161 AC3)。空配列なら満たす。
 *
 * - `finally` で戻さない: timeout でページが閉じられると `finally` の中の `await` は即 reject し、
 *   復元されないまま run の残り全部が汚染される（`.claude/rules/opus5-autonomous-loop.md` の実測）
 * - `test.afterEach` で戻し、**その応答を `expect` で検査する**: 見ないと復元の失敗が沈黙する
 *
 * 字面の検査なので「正しく戻せているか」までは見ない（それは e2e 自身が見る）。
 * 見るのは、上の 2 つの退行が**黙って**入ることだけ。
 */
export function collectRestoreShapeViolations(source: string): string[] {
  const violations: string[] = [];
  if (/\bfinally\s*\{/.test(source)) violations.push('finally で後始末している');
  const start = source.indexOf('test.afterEach(');
  if (start < 0) {
    violations.push('test.afterEach が無い');
    return violations;
  }
  const end = source.indexOf('\n});', start);
  const body = source.slice(start, end < 0 ? undefined : end);
  if (!/expect\(\s*\w+\.ok\(\)/.test(body)) violations.push('afterEach が復元の応答を expect していない');
  return violations;
}
