/**
 * Cursor Cloud Agent 環境スクリプトの不変条件。
 *
 * ## なぜ要るか
 *
 * Claude Code on the web は `scripts/cloud-setup.sh` を環境ダイアログへ貼る正本にしている。
 * Cursor Cloud Agents も同じ型（ダッシュボードの install / start が実行実体、repo 側は正本）
 * にしないと、片方だけ直してドリフトする（#545 で semgrep 修正がダイアログに追随せず
 * `--full` の sast が SKIP になったのと同型）。
 *
 * ここは分岐の期待値ではなく、満たすべき不変条件を縛る。
 *
 * - **上界**: install は終了する（dev server を立ち上げない）。start は port 3000 を占有しない
 *   （e2e の `npm run start` と衝突する）
 * - **下界**: 品質ゲートが SKIP に落ちない道具（gitleaks / semgrep / Playwright / aws）と
 *   root+infra の npm ci が install に居る。start は lockfile ドリフト時だけ npm ci する
 * - **上書き禁止**: `.cursor/environment.json` をリポジトリに置かない。置くと
 *   ダッシュボードの personal snapshot 環境を上書きし、焼き込んだベースラインが消える
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANUAL_ONLY_ALLOWLIST } from '../../scripts/check-script-wiring';

const ROOT = process.cwd();
const INSTALL = resolve(ROOT, 'scripts/cursor-cloud-install.sh');
const START = resolve(ROOT, 'scripts/cursor-cloud-start.sh');
const DOCS = resolve(ROOT, 'docs/cloud-dev-environment.md');

function body(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

describe('Cursor Cloud Agent 環境の正本', () => {
  it('install / start の正本ファイルが存在する（下界）', () => {
    expect(existsSync(INSTALL), 'scripts/cursor-cloud-install.sh が無い').toBe(true);
    expect(existsSync(START), 'scripts/cursor-cloud-start.sh が無い').toBe(true);
  });

  it('ダッシュボード snapshot を上書きする .cursor/environment.json をコミットしない', () => {
    expect(existsSync(resolve(ROOT, '.cursor/environment.json'))).toBe(false);
  });

  it('手動スクリプトとして allowlist に理由付きで載っている', () => {
    expect(MANUAL_ONLY_ALLOWLIST['cursor-cloud-install.sh']?.trim()).toBeTruthy();
    expect(MANUAL_ONLY_ALLOWLIST['cursor-cloud-start.sh']?.trim()).toBeTruthy();
  });

  it('docs/cloud-dev-environment.md が正本ファイルと上書き禁止を名指ししている', () => {
    const docs = readFileSync(DOCS, 'utf8');
    expect(docs).toContain('cursor-cloud-install.sh');
    expect(docs).toContain('cursor-cloud-start.sh');
    expect(docs).toContain('.cursor/environment.json');
  });
});

describe('cursor-cloud-install.sh', () => {
  it('冪等な npm ci（root と infra）と Playwright chromium を入れる', () => {
    const src = body(INSTALL);
    expect(src).toContain('needs_install');
    expect(src).toMatch(/npm ci(?! --prefix)/);
    expect(src).toContain('npm ci --prefix infra');
    expect(src).toMatch(/playwright install\b/);
    expect(src).toContain('chromium');
  });

  it('品質ゲートが SKIP に落ちない道具を入れる（gitleaks / semgrep / aws）', () => {
    const src = body(INSTALL);
    expect(src).toContain('gitleaks');
    expect(src).toContain('semgrep');
    expect(src).toMatch(/\baws\b/);
  });

  it('dev server を起動しない（install は終了しなければならない）', () => {
    const src = body(INSTALL);
    expect(src).not.toMatch(/npm run dev\b/);
    expect(src).not.toMatch(/npm run start\b/);
    expect(src).not.toMatch(/next start\b/);
  });
});

describe('cursor-cloud-start.sh', () => {
  it('lockfile ドリフト時だけ npm ci し、サーバは起動しない', () => {
    const src = body(START);
    expect(src).toContain('needs_install');
    expect(src).toContain('npm ci');
    expect(src).not.toMatch(/npm run dev\b/);
    expect(src).not.toMatch(/npm run start\b/);
    expect(src).not.toMatch(/:3000\b/);
    expect(src).not.toContain('playwright');
    expect(src).not.toContain('gitleaks');
    expect(src).not.toContain('semgrep');
  });

  it('needs_install の本体が install 正本と一致する（ドリフト防止）', () => {
    const extract = (path: string): string => {
      const text = body(path);
      const start = text.indexOf('needs_install()');
      expect(start, `${path} に needs_install() が無い`).toBeGreaterThan(-1);
      const brace = text.indexOf('{', start);
      let depth = 0;
      for (let i = brace; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) return text.slice(start, i + 1).replace(/\s+/g, ' ');
        }
      }
      throw new Error(`needs_install の閉じ括弧が見つからない: ${path}`);
    };
    expect(extract(START)).toBe(extract(INSTALL));
  });
});
