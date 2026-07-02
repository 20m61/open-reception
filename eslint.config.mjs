import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';

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
    },
  },
];

export default eslintConfig;
