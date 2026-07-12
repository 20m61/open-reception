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
  //
  // 移行済み（allowlist から削除＝厳格検証対象。値を厳密保存した無回帰リファクタ）:
  //   [1st] admin フォーム/ナビ群（4f64332）: AdminCredentialsLogin / AdminNav /
  //     AdminPasswordLogin / LanguageSettingsManager。
  //   [2nd] 本増分:
  //     - policy 1 白ボーダー収れん: CsvImport / KiosksManager / StaffEditor /
  //       TenantSwitcher（admin）。primary インク #0f172a→var(--color-bg-2)（同値）、白ボーダーは
  //       最近傍トークンへ収れん（0.08/0.1→--color-border、0.12/0.15/0.2→--color-border-strong。
  //       0.2→0.16 は 45a4a05 の収れん決定の延長として受容済みの α 差分）。
  //     - policy 2 platform 一式: 独自パレット #e0a880/#e66e6e/#7fe0a0 を globals.css の
  //       --color-platform-warn/danger/ok へ単一ソース化。可変 alpha は
  //       color-mix(in srgb, var(--color-platform-*) N%, transparent) で厳密再現（無回帰）。
  //       primitives の状態ピルの ad-hoc 緑/橙（#50c878/#c87850 相当）は ok/warn soft へ統一
  //       （18% alpha 上での軽微な色相補正）。
  //     - policy 3 visitor kiosk（exact のみ）: LocalizedWelcome / CustomFlowRenderer /
  //       VisitorInfoForm / SignageDisplay。CSS 変数フォールバックの生値除去（描画不変）と
  //       #0f172a→var(--color-bg-2)（同値）のみ。
  //
  // 引き続き許可（残債）。理由付き:
  //   - policy 4 機能色（テーマ非対象。意図的にトークン化しない）。各エントリに inline 注記:
  //       BrandingManager（色ピッカー既定値）/ DevicesManager・ReservationsManager（QR 背景）。
  //   - DangerActionButton.tsx: 破壊操作ボタンの白インク #fff。既存 var へ exact 化できず
  //     （--color-text=#f6f9ff とは微差、.btn--danger は逆に #0f172a の暗インク）、視覚差分の
  //     採否はオーケストレータ判断を要するため据え置き（policy 1〜4 いずれの対象でもない）。
  //   - policy 3 defer（新規変数/視覚回帰リスクで見送り。e2e キャプチャ前提で別バッチ）:
  //       LanguageSwitcher（accent 上の #fff、--color-accent-ink とは逆コントラスト）、
  //       AvatarGuide（字幕スクリム rgba(0,0,0,0.6) と白 6% 地色に既存 var が無い）、
  //       CheckoutFlow（白 0.1 ボーダー、来訪者向けの α 差分回避）。
  'src/components/admin/BrandingManager.tsx', // 機能色: 色ピッカー既定値 #38bdf8（input[type=color] は生 hex 必須）
  'src/components/admin/DevicesManager.tsx', // 機能色: QR 背景 #fff（読取のための固定色。テーマ非対象）
  'src/components/admin/ReservationsManager.tsx', // 機能色: QR 背景 #fff（読取のための固定色。テーマ非対象）
  'src/components/admin/danger/DangerActionButton.tsx', // 残債: 破壊ボタンの白インク #fff（exact 化不可・要判断）
  // kiosk（policy 3 defer。視覚回帰リスク/新規変数が必要）:
  'src/components/kiosk/LanguageSwitcher.tsx',
  'src/components/kiosk/avatar/AvatarGuide.tsx',
  'src/components/kiosk/checkout/CheckoutFlow.tsx',
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
