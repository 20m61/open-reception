import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * #985: 欠けていたゲート道具を SessionStart で戻す。
 *
 * 由来: 2026-09-05 と 2026-09-06 の**2 セッション連続**で `gitleaks` / `semgrep` が
 * 入っていない状態で起動した（`docs/cloud-dev-environment.md` §0-G）。gitleaks 不在は
 * SKIP では済まず、`tests/hooks/push-secret-guard.test.ts` の前提検査が落ちて
 * **`--pr` が原理的に完走しない**（#986 / #988）。2026-09-06 のデプロイでは、この復旧が
 * **窓を最も消費した要因**だった。
 */
describe('gate-tooling の復旧 (#985)', () => {
  const RESTORE = join(ROOT, 'scripts/restore-gate-tools.sh');

  it('install_pkgs.sh が報告の「前」に復旧を呼ぶ', () => {
    const src = readFileSync(join(ROOT, 'scripts/install_pkgs.sh'), 'utf8');
    expect(src).toContain('restore-gate-tools.sh');
    // 🔴 順序が肝。逆にすると、直後に戻したものを MISSING と報告してしまい、
    // 人が読む唯一の信号が嘘になる。
    expect(src.indexOf('restore-gate-tools.sh')).toBeLessThan(src.indexOf('gate_tool_report'));
  });

  it('cursor-cloud-install.sh も同じ復旧を呼ぶ（写しを増やさない）', () => {
    const src = readFileSync(join(ROOT, 'scripts/cursor-cloud-install.sh'), 'utf8');
    expect(src).toContain('restore-gate-tools.sh');
    // インストール手順を書き写していないこと（版がズレる元）
    expect(src).not.toContain('gitleaks_');
    expect(src).not.toContain('PyJWT');
  });

  /**
   * 🔴 **版の写しがズレないことを機械で縛る。** `cloud-setup.sh` は環境ダイアログへ
   * 貼る内容の正本で、リポジトリのファイルを source できない（クローン前に走る）ため
   * インストール手順を持たざるを得ない。**同じ版であること**だけを検査する ――
   * ズレると「復旧したのに Setup script と違う版が入る」状態になり、しかも誰も気づかない。
   */
  it('gitleaks の版が cloud-setup.sh と一致する', () => {
    const restore = readFileSync(RESTORE, 'utf8');
    const setup = readFileSync(join(ROOT, 'scripts/cloud-setup.sh'), 'utf8');
    const restoreVersion = /GITLEAKS_VERSION=([0-9.]+)/.exec(restore)?.[1];
    const setupVersion = /GL=([0-9.]+)/.exec(setup)?.[1];
    expect(restoreVersion, '復旧スクリプトから版を読めない').toBeDefined();
    expect(setupVersion, 'cloud-setup.sh から版を読めない').toBeDefined();
    expect(restoreVersion).toBe(setupVersion);
  });

  it('道具が揃っていれば何もしない（毎セッションの起動を延ばさない）', () => {
    const r = spawnSync('bash', [RESTORE], {
      encoding: 'utf8',
      env: { ...process.env, OPEN_RECEPTION_TOOL_RESTORE_DRY_RUN: '1' },
    });
    expect(r.status).toBe(0);
    // このセッションは復旧済みなので、何も出ない（出るなら「揃っていても走る」退行）
    expect(r.stderr).toBe('');
  });

  it('🔴 欠けていたら両方を戻しにいく', () => {
    const stub = mkdtempSync(join(tmpdir(), 'no-tools-'));
    try {
      const r = spawnSync('bash', [RESTORE], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stub}:/usr/bin:/bin`,
          OPEN_RECEPTION_TOOL_RESTORE_DRY_RUN: '1',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('gitleaks');
      expect(r.stderr).toContain('semgrep');
      // 版は cloud-setup.sh と同じものを取りに行く
      const setup = readFileSync(join(ROOT, 'scripts/cloud-setup.sh'), 'utf8');
      expect(r.stderr).toContain(/GL=([0-9.]+)/.exec(setup)![1]);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **復旧に失敗しても呼び出し元を落とさない。** SessionStart が非ゼロで終わると
   * セッションごと起動しない（`scripts/cloud-setup.sh` 冒頭の制約と同じ理由）。
   * ただし**黙って緑にしない** ―― 失敗したことは stderr に出し、直後の
   * `gate_tool_report` が欠落を名指しする。
   */
  it('🔴 取得に失敗しても exit 0（ただし黙らない）', () => {
    const stub = mkdtempSync(join(tmpdir(), 'broken-curl-'));
    try {
      writeFileSync(join(stub, 'curl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(stub, 'pip'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const r = spawnSync('bash', [RESTORE], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stub}:/usr/bin:/bin` },
      });
      expect(r.status, 'SessionStart を落としてはいけない').toBe(0);
      // 🔴 **どちらの道具が戻せなかったかまで見る。** `FAILED` の有無だけを見ると、
      // 片方の報告を消す変異が生存する（実測）。
      expect(r.stderr, 'gitleaks の失敗を黙って飲み込んでいる').toContain('gitleaks: restore FAILED');
      expect(r.stderr, 'semgrep の失敗を黙って飲み込んでいる').toContain('semgrep: restore FAILED');
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it('明示的に止められる（オフライン環境向け）', () => {
    const stub = mkdtempSync(join(tmpdir(), 'no-tools-'));
    try {
      const r = spawnSync('bash', [RESTORE], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stub}:/usr/bin:/bin`,
          OPEN_RECEPTION_SKIP_TOOL_RESTORE: '1',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('skipped');
      expect(r.stderr).not.toContain('restoring');
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});
