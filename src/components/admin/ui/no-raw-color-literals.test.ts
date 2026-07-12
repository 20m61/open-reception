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

  // #329 AC(2) 続き: 白ボーダー収れん（policy 1）・platform セマンティック変数（policy 2）・
  // exact 保存の kiosk（policy 3）を単一ソース化した増分。allowlist から外して厳格検証対象にした。
  it('白ボーダー収れん済みの admin フォーム群は allowlist から外れている (policy 1)', () => {
    const migrated = [
      'src/components/admin/CsvImport.tsx',
      'src/components/admin/KiosksManager.tsx',
      'src/components/admin/StaffEditor.tsx',
      'src/components/admin/TenantSwitcher.tsx',
    ];
    for (const f of migrated) {
      expect(RAW_COLOR_ALLOWLIST).not.toContain(f);
    }
  });

  it('platform 一式はセマンティック変数へ移行し allowlist から外れている (policy 2)', () => {
    const migrated = [
      'src/components/admin/platform/AuditLogs.tsx',
      'src/components/admin/platform/ElevationStatus.tsx',
      'src/components/admin/platform/FeatureFlags.tsx',
      'src/components/admin/platform/Integrations.tsx',
      'src/components/admin/platform/MaintenanceStatus.tsx',
      'src/components/admin/platform/NoticePublishForm.tsx',
      'src/components/admin/platform/Observability.tsx',
      'src/components/admin/platform/PlatformDashboard.tsx',
      'src/components/admin/platform/TenantDetail.tsx',
      'src/components/admin/platform/TenantList.tsx',
      'src/components/admin/platform/TenantSwitcher.tsx',
      'src/components/admin/platform/UpdateStatus.tsx',
      'src/components/admin/platform/primitives.tsx',
    ];
    for (const f of migrated) {
      expect(RAW_COLOR_ALLOWLIST).not.toContain(f);
    }
  });

  it('exact 保存で移行した visitor 向け kiosk は allowlist から外れている (policy 3)', () => {
    const migrated = [
      'src/components/kiosk/LocalizedWelcome.tsx',
      'src/components/kiosk/custom-flow/CustomFlowRenderer.tsx',
      'src/components/kiosk/custom-flow/VisitorInfoForm.tsx',
      'src/components/kiosk/signage/SignageDisplay.tsx',
    ];
    for (const f of migrated) {
      expect(RAW_COLOR_ALLOWLIST).not.toContain(f);
    }
  });

  // 視覚回帰リスク/新規変数が必要なため本増分では意図的に残す負債（policy 3/4）。
  // 「残すべきものが誤って外れていない」ことも固定し、機能色の誤トークン化を防ぐ。
  it('機能色・視覚回帰リスクのファイルは allowlist に残す (policy 3/4 の残債)', () => {
    const deferred = [
      // policy 4: 機能色（テーマ非対象）。
      'src/components/admin/BrandingManager.tsx',
      'src/components/admin/DevicesManager.tsx',
      'src/components/admin/ReservationsManager.tsx',
      // policy 4 外だが exact 化できない #fff ボタンインク（要判断）。
      'src/components/admin/danger/DangerActionButton.tsx',
      // policy 3: 新規変数/視覚回帰リスクで defer。
      'src/components/kiosk/LanguageSwitcher.tsx',
      'src/components/kiosk/avatar/AvatarGuide.tsx',
      'src/components/kiosk/checkout/CheckoutFlow.tsx',
    ];
    for (const f of deferred) {
      expect(RAW_COLOR_ALLOWLIST).toContain(f);
    }
  });

  it('platform セマンティック変数が tokens.ts にミラーされている (policy 2)', async () => {
    const { color } = await import('./tokens');
    expect(color.platformWarn).toBe('var(--color-platform-warn)');
    expect(color.platformDanger).toBe('var(--color-platform-danger)');
    expect(color.platformOk).toBe('var(--color-platform-ok)');
  });
});
