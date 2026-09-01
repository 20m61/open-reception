import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCrossBrowserReplicaProject,
  isSoakSpec,
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
});

describe('playwright.config.ts の project 所有 (#818)', () => {
  it('soak 以外の全 spec がちょうど 1 つの project に載る', async () => {
    const config = (await import('../../playwright.config')).default;
    const projects = ((config.projects ?? []) as E2eProjectSlice[]).filter(
      (p) => !isCrossBrowserReplicaProject(p.name),
    );
    const specs = listE2eSpecRelPaths(E2E_DIR);
    expect(specs.length, 'e2e spec が 1 本も無い（走査が空）').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const spec of specs) {
      const owners = owningProjectNames(spec, projects);
      if (isSoakSpec(spec)) {
        if (owners.length !== 0) {
          violations.push(`${spec}: soak なのに ${owners.join(',')}`);
        }
        continue;
      }
      if (owners.length !== 1) {
        violations.push(`${spec}: ${owners.length === 0 ? 'どこにも載っていない' : owners.join(',')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
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
