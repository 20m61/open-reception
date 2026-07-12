import path from 'node:path';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule, { RAW_COLOR_ALLOWLIST } from '../../../../eslint-rules/no-raw-color-literals.mjs';

/**
 * 生の色リテラル禁止ルールの検証 (issue #329)。
 * enforced ファイル（allowlist 外）では HEX / rgba を報告し、トークン参照や allowlist 済み
 * ファイルは通すことを確認する。
 */
const ENFORCED = path.join(process.cwd(), 'src/components/admin/dashboard/NewScreen.tsx');
const ALLOWLISTED = path.join(process.cwd(), 'src/components/admin/ui/tokens.ts');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('no-raw-color-literals', rule, {
  valid: [
    // トークン / CSS 変数参照は許可。
    { code: "const s = { color: 'var(--color-accent)' };", filename: ENFORCED },
    { code: "const s = { border: `1px solid ${x}` };", filename: ENFORCED },
    // Issue 参照など 2 桁 # は色ではない。
    { code: "const s = 'issue #92';", filename: ENFORCED },
    // allowlist 済みファイルは直書きでも通す（段階移行の負債）。
    { code: "const s = { color: '#38bdf8' };", filename: ALLOWLISTED },
  ],
  invalid: [
    {
      code: "const s = { color: '#38bdf8' };",
      filename: ENFORCED,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: "const s = { background: 'rgba(255,255,255,0.1)' };",
      filename: ENFORCED,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: 'const s = { border: `1px solid #fff` };',
      filename: ENFORCED,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: 'const el = <div style={{ color: "#c00" }} />;',
      filename: ENFORCED,
      errors: [{ messageId: 'rawColor' }],
    },
  ],
});

// RuleTester.run が describe/it を内部で使うため、Vitest 収集用のダミーを 1 件置く。
describe('RAW_COLOR_ALLOWLIST の健全性 (#329)', () => {
  it('色の定義元 tokens.ts を含み、重複が無い', () => {
    expect(RAW_COLOR_ALLOWLIST).toContain('src/components/admin/ui/tokens.ts');
    expect(new Set(RAW_COLOR_ALLOWLIST).size).toBe(RAW_COLOR_ALLOWLIST.length);
  });

  it('移行済みの ExperienceKpiSection は allowlist から外れている', () => {
    expect(RAW_COLOR_ALLOWLIST).not.toContain(
      'src/components/admin/dashboard/ExperienceKpiSection.tsx',
    );
  });

  // #329 AC(2): admin フォーム/ナビ群を単一ソース化した増分。allowlist から外したので
  // 以後これらのファイルへ生の色を戻すとルールが即エラーにする（再追加を防ぐ回帰ガード）。
  it('移行済みの admin フォーム/ナビ群は allowlist から外れている', () => {
    const migrated = [
      'src/components/admin/AdminCredentialsLogin.tsx',
      'src/components/admin/AdminNav.tsx',
      'src/components/admin/AdminPasswordLogin.tsx',
      'src/components/admin/LanguageSettingsManager.tsx',
    ];
    for (const f of migrated) {
      expect(RAW_COLOR_ALLOWLIST).not.toContain(f);
    }
  });
});
