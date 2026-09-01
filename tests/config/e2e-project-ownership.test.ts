import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectOwnershipViolations,
  isCrossBrowserReplicaProject,
  isPlatformSpec,
  isPlaywrightDiscoveredTestFile,
  listE2eSpecRelPaths,
  owningProjectNames,
  patternMatchesSpec,
  playwrightStyleFilePath,
  projectOwnsSpec,
  type E2eProjectSlice,
} from './e2e-project-ownership';

const IMPORT_TIMEOUT_MS = 30_000;
const ROOT = join(import.meta.dirname, '../..');
const E2E_DIR = join(ROOT, 'tests/e2e');

const ISOLATED_SPEC = 'kiosk-flow-integration.spec.ts';
const DEFAULT_SPEC = 'kiosk-touch-first.spec.ts';
const PLATFORM_SPEC = 'platform-area-switch.spec.ts';

function cloneProjects(projects: readonly E2eProjectSlice[]): E2eProjectSlice[] {
  return projects.map((p) => ({
    name: p.name,
    testMatch: p.testMatch,
    testIgnore: Array.isArray(p.testIgnore) ? [...p.testIgnore] : p.testIgnore,
  }));
}

describe('e2e-project-ownership (純関数)', () => {
  const isolated: E2eProjectSlice = {
    name: 'flow-mutation-kiosk',
    testMatch: /kiosk-flow-integration\.spec\.ts$/,
  };
  const def: E2eProjectSlice = {
    name: 'chromium-ipad',
    testIgnore: [/kiosk-flow-integration\.spec\.ts$/, /\/soak\//],
  };

  it('basename アンカーの testMatch が隔離 spec を拾う', () => {
    expect(patternMatchesSpec(isolated.testMatch, ISOLATED_SPEC)).toBe(true);
    expect(patternMatchesSpec(isolated.testMatch, DEFAULT_SPEC)).toBe(false);
  });

  it('ディレクトリ付き ignore が soak を除外する（Playwright は絶対パスに当てる）', () => {
    const soakRel = 'soak/soak-kiosk.spec.ts';
    // 本体と同じく testDir 相対には `/soak/` が無い。ここが外れる実装だと
    // chromium-ipad が soak を「所有している」と誤判定する。
    expect(/\/soak\//.test(soakRel)).toBe(false);
    expect(/\/soak\//.test(playwrightStyleFilePath(soakRel))).toBe(true);
    expect(patternMatchesSpec(/\/soak\//, soakRel)).toBe(true);
    expect(patternMatchesSpec(/\/soak\//, ISOLATED_SPEC)).toBe(false);
  });

  it('文字列 matcher は Playwright と同じ glob 意味論で当たる', () => {
    expect(patternMatchesSpec('**/kiosk-flow-integration.spec.ts', ISOLATED_SPEC)).toBe(true);
    expect(patternMatchesSpec('kiosk-flow-integration.spec.ts', ISOLATED_SPEC)).toBe(true);
    expect(patternMatchesSpec('**/kiosk-flow-integration.spec.ts', DEFAULT_SPEC)).toBe(false);
    expect(patternMatchesSpec('**/admin-*.spec.ts', 'admin-site-scope.spec.ts')).toBe(true);
    expect(patternMatchesSpec('**/admin-*.spec.ts', ISOLATED_SPEC)).toBe(false);
  });

  it('隔離 spec は隔離 project だけが所有する', () => {
    expect(owningProjectNames(ISOLATED_SPEC, [def, isolated])).toEqual(['flow-mutation-kiosk']);
  });

  it('既定 spec は chromium-ipad だけが所有する', () => {
    expect(owningProjectNames(DEFAULT_SPEC, [def, isolated])).toEqual(['chromium-ipad']);
  });

  it('testMatch が無い project は ignore 以外を全部対象にする', () => {
    expect(projectOwnsSpec(def, DEFAULT_SPEC)).toBe(true);
    expect(projectOwnsSpec(def, ISOLATED_SPEC)).toBe(false);
  });

  it('platform spec は platform-developer が無いとき 0 件が正しい', () => {
    expect(isPlatformSpec(PLATFORM_SPEC)).toBe(true);
    expect(isPlatformSpec('capture-screens-platform.spec.ts')).toBe(true);
    expect(isPlatformSpec(DEFAULT_SPEC)).toBe(false);
    const remoteProjects: E2eProjectSlice[] = [
      { name: 'chromium-ipad', testIgnore: [/platform-/, /capture-screens-platform/, /\/soak\//] },
    ];
    expect(owningProjectNames(PLATFORM_SPEC, remoteProjects)).toEqual([]);
    expect(collectOwnershipViolations([PLATFORM_SPEC, DEFAULT_SPEC], remoteProjects)).toEqual([]);
  });

  it('platform spec は platform-developer があるとき 0 件だと違反', () => {
    const localProjects: E2eProjectSlice[] = [
      { name: 'chromium-ipad', testIgnore: [/platform-/, /capture-screens-platform/] },
      { name: 'platform-developer', testMatch: /platform-/ },
    ];
    expect(collectOwnershipViolations([PLATFORM_SPEC], localProjects)).toEqual([]);
    const forgottenMatch = cloneProjects(localProjects);
    forgottenMatch[1]!.testMatch = /(?!)/;
    expect(collectOwnershipViolations([PLATFORM_SPEC], forgottenMatch)).toEqual([
      `${PLATFORM_SPEC}: どこにも載っていない`,
    ]);
  });
});

describe('Playwright 既定の発見対象ファイル', () => {
  it('*.spec.ts 以外の Playwright 既定拡張子も拾う', () => {
    expect(isPlaywrightDiscoveredTestFile('flow.spec.ts')).toBe(true);
    expect(isPlaywrightDiscoveredTestFile('flow.test.ts')).toBe(true);
    expect(isPlaywrightDiscoveredTestFile('flow.spec.tsx')).toBe(true);
    expect(isPlaywrightDiscoveredTestFile('flow.test.mts')).toBe(true);
    expect(isPlaywrightDiscoveredTestFile('helpers.ts')).toBe(false);
  });

  it('listE2eSpecRelPaths は既定拡張子を再帰列挙する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-own-'));
    try {
      writeFileSync(join(dir, 'a.spec.ts'), '');
      writeFileSync(join(dir, 'b.test.ts'), '');
      writeFileSync(join(dir, 'c.spec.tsx'), '');
      writeFileSync(join(dir, 'ignored.ts'), '');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'd.spec.mts'), '');
      expect(listE2eSpecRelPaths(dir)).toEqual(['a.spec.ts', 'b.test.ts', 'c.spec.tsx', 'sub/d.spec.mts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('playwright.config.ts の project 所有 (#818)', () => {
  it('soak 以外の全 spec がちょうど 1 つの project に載る', async () => {
    const config = (await import('../../playwright.config')).default;
    const projects = (config.projects ?? []) as E2eProjectSlice[];
    const specs = listE2eSpecRelPaths(E2E_DIR);
    expect(specs.length, 'e2e spec が 1 本も無い（走査が空）').toBeGreaterThan(0);

    const violations = collectOwnershipViolations(specs, projects);
    expect(violations, violations.join('\n')).toEqual([]);
  }, IMPORT_TIMEOUT_MS);

  it('PLAYWRIGHT_BASE_URL 指定時も platform spec を違反にしない', async () => {
    vi.resetModules();
    const previous = process.env.PLAYWRIGHT_BASE_URL;
    process.env.PLAYWRIGHT_BASE_URL = 'https://example.test';
    try {
      const config = (await import('../../playwright.config')).default;
      const projects = (config.projects ?? []) as E2eProjectSlice[];
      expect(
        projects.some((p) => p.name === 'platform-developer'),
        'remote なのに platform-developer が残っている',
      ).toBe(false);
      const specs = listE2eSpecRelPaths(E2E_DIR);
      const platform = specs.filter((s) => isPlatformSpec(s));
      expect(platform.length, 'platform spec が 1 本も無い').toBeGreaterThan(0);
      const violations = collectOwnershipViolations(specs, projects);
      expect(violations, violations.join('\n')).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
      else process.env.PLAYWRIGHT_BASE_URL = previous;
      vi.resetModules();
    }
  }, IMPORT_TIMEOUT_MS);

  it('DEFAULT_TEST_IGNORE への追加を忘れると隔離 spec が 2 つの project に載る', async () => {
    const config = (await import('../../playwright.config')).default;
    const projects = cloneProjects((config.projects ?? []) as E2eProjectSlice[]).filter(
      (p) => !isCrossBrowserReplicaProject(p.name),
    );
    const ipad = projects.find((p) => p.name === 'chromium-ipad');
    expect(ipad, 'chromium-ipad project が無い').toBeDefined();
    const ignore = Array.isArray(ipad!.testIgnore) ? ipad!.testIgnore : [ipad!.testIgnore];
    ipad!.testIgnore = ignore.filter((p) => !patternMatchesSpec(p, ISOLATED_SPEC));

    const owners = owningProjectNames(ISOLATED_SPEC, projects);
    expect(owners, `隔離が無効化された所有: ${owners.join(',')}`).toHaveLength(2);
    expect(owners).toEqual(expect.arrayContaining(['chromium-ipad', 'flow-mutation-kiosk']));
  }, IMPORT_TIMEOUT_MS);

  it('新 project の testMatch を書き忘れると隔離 spec がどこにも載らない', async () => {
    const config = (await import('../../playwright.config')).default;
    const projects = cloneProjects((config.projects ?? []) as E2eProjectSlice[]).filter(
      (p) => !isCrossBrowserReplicaProject(p.name),
    );
    const isolated = projects.find((p) => p.name === 'flow-mutation-kiosk');
    expect(isolated, 'flow-mutation-kiosk project が無い').toBeDefined();
    isolated!.testMatch = /(?!)/;

    const owners = owningProjectNames(ISOLATED_SPEC, projects);
    expect(owners, `載らないはずが ${owners.join(',')} に載った`).toEqual([]);
  }, IMPORT_TIMEOUT_MS);
});
