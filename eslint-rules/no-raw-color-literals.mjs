/**
 * `src/components/**` の「生の色リテラル（HEX / rgb(a) / hsl(a)）」を禁止する
 * ローカル ESLint ルール (issue #329)。
 *
 * 目的:
 *   テナントテーマ（`--brand-accent`）やコントラスト調整を全画面へ波及させるため、色は
 *   **単一ソース**（`src/app/globals.css` の CSS 変数と、それを参照する
 *   `src/components/admin/ui/tokens.ts`）だけで定義する。コンポーネントに色を直書き
 *   （`#38bdf8` / `rgba(255,255,255,0.1)` 等）すると、その画面だけテーマが届かなくなる。
 *
 * 方針（#327 の `scripts/check-cjk-literals.ts` と同じファイル単位 allowlist 方式）:
 *   - 文字列リテラル / テンプレートリテラルの各要素 / JSX テキストのみを対象にする
 *     （**コメントは対象外**＝JSDoc の `#319` 等の Issue 参照は誤検知しない）。
 *   - `RAW_COLOR_ALLOWLIST` に載るファイルは対象外。これは #329 着手時点で既に色を
 *     直書きしている 700+ 箇所（73 ファイル）を段階移行するための負債リストであり、
 *     画面単位で移行しながらこの配列から外していく（外した瞬間から厳格検証される）。
 *   - 色の「定義元」である `tokens.ts` も allowlist に含める（rgba のパレットを持つため）。
 *
 * 制約: allowlist 済みファイルへの「新規」直書き追加までは検出しない（ファイル単位のため）。
 * 行単位 diff 検出は follow-up（レポートに明記）。
 */
import path from 'node:path';

/**
 * HEX（3/4/6/8 桁）と色関数 `rgb()/rgba()/hsl()/hsla()` を検出する。
 * `\b` 終端で Issue 参照（`#92` 等 2 桁）や 6 桁超の連番を弾く。色関数は語境界始まりで
 * `srgb(` のような別名を除外する。
 */
const RAW_COLOR_PATTERN =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\s*\(/;

/**
 * 移行前の既存直書きファイル（リポジトリルートからの相対・POSIX 区切り）。
 * #329 着手時点のスナップショット。ここに無いファイルへ色を直書きすると即エラー。
 * `tokens.ts` は色の定義元として恒久的に許可する。
 */
export const RAW_COLOR_ALLOWLIST = [
  // ---- 色の定義元（恒久的に許可: rgba パレットを持つ） ----
  'src/components/admin/ui/tokens.ts',
  // ---- 移行前の既存直書き（#329 で段階移行する負債・AST 検出スナップショット） ----
  'src/components/admin/AdminCredentialsLogin.tsx',
  'src/components/admin/AdminNav.tsx',
  'src/components/admin/AdminPasswordLogin.tsx',
  'src/components/admin/BrandingManager.tsx',
  'src/components/admin/CsvImport.tsx',
  'src/components/admin/DevicesManager.tsx',
  'src/components/admin/KiosksManager.tsx',
  'src/components/admin/LanguageSettingsManager.tsx',
  'src/components/admin/ReservationsManager.tsx',
  'src/components/admin/StaffEditor.tsx',
  'src/components/admin/TenantSwitcher.tsx',
  'src/components/admin/danger/DangerActionButton.tsx',
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
  // kiosk（別トラック #324/#327/#328 が所有。#329 では触らず allowlist のみ）:
  'src/components/kiosk/LanguageSwitcher.tsx',
  'src/components/kiosk/LocalizedWelcome.tsx',
  'src/components/kiosk/avatar/AvatarGuide.tsx',
  'src/components/kiosk/checkout/CheckoutFlow.tsx',
  'src/components/kiosk/custom-flow/CustomFlowRenderer.tsx',
  'src/components/kiosk/custom-flow/VisitorInfoForm.tsx',
  'src/components/kiosk/signage/SignageDisplay.tsx',
];

function toRepoRelative(filename) {
  return path.relative(process.cwd(), filename).split(path.sep).join('/');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '生の色リテラル（HEX / rgb(a) / hsl(a)）を禁止し、色を globals.css の CSS 変数と tokens.ts へ集約する (#329)',
    },
    schema: [],
    messages: {
      rawColor:
        '生の色リテラル "{{value}}" は禁止です。globals.css の CSS 変数（var(--…)）か admin/ui/tokens.ts のトークンを使ってください (#329)。',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const rel = toRepoRelative(filename);
    if (RAW_COLOR_ALLOWLIST.includes(rel)) return {};

    function check(node, raw) {
      if (typeof raw !== 'string') return;
      const match = RAW_COLOR_PATTERN.exec(raw);
      if (match) {
        context.report({ node, messageId: 'rawColor', data: { value: match[0] } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};

export default rule;
