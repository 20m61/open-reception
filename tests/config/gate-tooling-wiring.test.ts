import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '../..');

describe('gate-tooling 配線 (#838)', () => {
  it('install_pkgs.sh が SessionStart で report を呼ぶ', () => {
    const src = readFileSync(join(ROOT, 'scripts/install_pkgs.sh'), 'utf8');
    expect(src).toContain('gate-tooling.sh');
    expect(src).toContain('gate_tool_report');
    expect(src).toContain('#838');
  });

  it('cursor-cloud-install.sh が install 末尾で report を呼ぶ', () => {
    const src = readFileSync(join(ROOT, 'scripts/cursor-cloud-install.sh'), 'utf8');
    expect(src).toContain('gate-tooling.sh');
    expect(src).toContain('gate_tool_report');
  });

  it('quality-gate.sh は playwright chromium 欠落を e2e/vrm の skip_unverified にする', () => {
    const src = readFileSync(join(ROOT, 'scripts/quality-gate.sh'), 'utf8');
    expect(src).toContain('gate_tool_playwright_chromium_present');
    expect(src).toMatch(
      /skip_unverified "e2e \(playwright\)" "playwright chromium not installed/,
    );
    expect(src).toMatch(
      /skip_unverified "vrm \(real render\)" "playwright chromium not installed/,
    );
    // 欠けを skip_or_fail（記録される SKIP）に倒す変異を止める
    expect(src).not.toMatch(
      /skip_or_fail "e2e \(playwright\)" "playwright chromium/,
    );
  });

  it('report-gate-tools.ts は argv 観測を SessionStart 文言へ通す', () => {
    const r = spawnSync(
      'npx',
      [
        '--yes',
        'tsx',
        'scripts/report-gate-tools.ts',
        'gitleaks=false',
        'semgrep=true',
        'aws=true',
        'playwrightChromium=false',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('missing');
    expect(r.stdout).toContain('gitleaks: MISSING');
    expect(r.stdout).toContain('push-secret-guard will SKIP');
    expect(r.stdout).toContain('playwrightChromium: MISSING');
  });

  it('全部 present の報告に MISSING が無い', () => {
    const r = spawnSync(
      'npx',
      [
        '--yes',
        'tsx',
        'scripts/report-gate-tools.ts',
        'gitleaks=true',
        'semgrep=true',
        'aws=true',
        'playwrightChromium=true',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('all optional tools present');
    expect(r.stdout).not.toContain('MISSING');
  });
});
