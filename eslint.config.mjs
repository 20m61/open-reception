import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';
import noRawColorLiterals from './eslint-rules/no-raw-color-literals.mjs';

/**
 * ESLint Flat Config (Next.js 16 で `next lint` が廃止されたため ESLint CLI へ移行)。
 * 旧 .eslintrc.json の extends（next/core-web-vitals, next/typescript）と
 * ignorePatterns / 独自 rules を移植する。
 */
const eslintConfig = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      '.open-next/**',
      'infra/**',
      'tests/e2e/**',
      'playwright-report/**',
      // vitest --coverage を回すと istanbul の HTML レポートが .js を同梱する。
      // lint 対象に入ると、変更と無関係に warning 予算 (#813) を超えてゲートが赤くなる。
      'coverage/**',
      'test-results/**',
      // isolation:"worktree" のサブエージェントがリポジトリ内 (.claude/worktrees/) に
      // worktree を作るため、走査すると path スコープの設定が外れて誤検知する。
      '.claude/worktrees/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // react-hooks v7（eslint-config-next 16 同梱）で新規追加されたルール。
      // 本リポジトリの「マウント時に async load() を呼ぶ」既存パターンを多数検出するが、
      // 意図的なデータ取得・heartbeat であり Next 15 時点では非エラーだった。
      // 機械的リファクタの回帰リスクを避けるため助言（warn）に留める。
      'react-hooks/set-state-in-effect': 'warn',
      /**
       * 🔴 **error にする** (#813)。既定は warn だが、warn は `--max-warnings` が無い間
       * ゲートを素通りしていた。#803（PR #812）の独立レビューで、`VoiceSessionLayer` の
       * effect 依存から `state` を落とす変異が **6789 tests 全緑・eslint exit=0** のまま
       * 通ることが実測されている（不在告知が一度も喋られなくなるのに）。
       *
       * このリポジトリは effect を node 環境で実行できず（jsdom 無し）、配線の防御線が
       * ソース文字列検査しか無い。依存配列の取りこぼしは**すべてこの穴を通る**ので、
       * このルールだけは助言ではなく停止させる。
       *
       * 既存の 6 件は #813 の周回で実際に直した。**実害があったのは 1 件**
       * （`VrmAvatarViewer` の視線が iPad の回転に追従しない）で、3 件は別の依存に
       * マスクされた潜在的取りこぼし、2 件は不要依存・挙動不変。内訳は
       * `docs/quality-gate.md`。
       * 意図的に依存を外す場合は `// eslint-disable-next-line` に**理由を書いて**抑止する。
       */
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // 生の色リテラル禁止 (#329)。色は globals.css の CSS 変数と admin/ui/tokens.ts に集約する。
    // 対象は components 配下のみ（テストは除外）。移行前の既存直書きはルール内蔵の
    // RAW_COLOR_ALLOWLIST（eslint-rules/no-raw-color-literals.mjs）で段階的に許可する。
    files: ['src/components/**/*.ts', 'src/components/**/*.tsx'],
    ignores: ['src/components/**/*.test.ts', 'src/components/**/*.test.tsx'],
    plugins: { 'design-tokens': { rules: { 'no-raw-color-literals': noRawColorLiterals } } },
    rules: {
      'design-tokens/no-raw-color-literals': 'error',
    },
  },
];

export default eslintConfig;
