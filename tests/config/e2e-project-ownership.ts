/**
 * Playwright project の testMatch / testIgnore を、resolver を介さず評価する (#818)。
 *
 * Playwright の実 resolver は glob 展開・依存 project・grep を含むため、
 * 「この spec はどの project で走るか」をテストから観測すると環境依存になる。
 * このモジュールは **config に書いた正規表現そのもの** を、Playwright 本体と同じ入力
 * （絶対パス）へ当てる。隔離 project を足すときに 2 箇所（testMatch と
 * `DEFAULT_TEST_IGNORE`）を協調編集し忘れると、ここで 0 件または 2 件になって落ちる。
 *
 * `soak/` は `playwright.soak.config.ts` 専用なので、本設定ではどの project にも
 * 載せない（0 件）のが正しい。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type E2eProjectSlice = {
  name: string;
  testMatch?: unknown;
  testIgnore?: unknown;
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
  const filePath = playwrightStyleFilePath(specRelPath);
  for (const p of asPatterns(pattern)) {
    if (p instanceof RegExp) {
      p.lastIndex = 0;
      if (p.test(filePath)) return true;
      continue;
    }
    if (typeof p === 'string') {
      const posix = specRelPath.replaceAll('\\', '/');
      const basename = posix.split('/').pop() ?? posix;
      if (p === posix || p === basename || filePath.endsWith(`/${p}`) || filePath.endsWith(p)) {
        return true;
      }
    }
  }
  return false;
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

/** `tests/e2e` 配下の `*.spec.ts` を testDir 相対パスで列挙する。 */
export function listE2eSpecRelPaths(testDir: string): SpecRelPath[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else if (name.endsWith('.spec.ts')) out.push(childRel);
    }
  };
  walk(testDir, '');
  return out.sort();
}

export function isSoakSpec(specRelPath: SpecRelPath): boolean {
  return specRelPath.split('/').includes('soak');
}
