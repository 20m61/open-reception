/**
 * `npm run lint` の実体 (#843)。ESLint を 1 回だけ回し、warning のルール別件数を
 * `LINT_WARNING_BUDGET` と exact match する。
 *
 * 総数の `--max-warnings` は内訳の悪化を見ないので使わない。合計は予算の和になる。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINT_WARNING_BUDGET,
  countWarningsByRule,
  diffLintWarningBudget,
  eslintJsonHasErrors,
  formatLintWarningBudgetViolations,
  lintWarningBudgetTotal,
  type EslintJsonFile,
} from '../src/domain/governance/lint-warning-budget';

const ESLINT = join(process.cwd(), 'node_modules', '.bin', 'eslint');
if (!existsSync(ESLINT)) {
  console.error('eslint が見つかりません: ' + ESLINT + '（npm ci を先に実行してください）');
  process.exit(2);
}

function eslintJson(extraArgs: readonly string[]): EslintJsonFile[] {
  try {
    return JSON.parse(
      execFileSync(ESLINT, ['.', '-f', 'json', ...extraArgs], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as EslintJsonFile[];
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      error.stdout.trim().startsWith('[')
    ) {
      return JSON.parse(error.stdout) as EslintJsonFile[];
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('eslint を JSON で実行できませんでした: ' + message);
    if (error !== null && typeof error === 'object' && 'stderr' in error && error.stderr) {
      console.error(String(error.stderr).trim());
    }
    process.exit(2);
  }
}

type PrintableMessage = {
  line?: number;
  column?: number;
  severity?: number;
  ruleId?: string | null;
  message?: string;
};

type PrintableFile = EslintJsonFile & {
  filePath?: string;
  messages?: readonly PrintableMessage[];
};

function printMessages(results: readonly PrintableFile[]): void {
  const cwd = process.cwd() + '/';
  for (const file of results) {
    const rel = (file.filePath ?? '').startsWith(cwd)
      ? (file.filePath ?? '').slice(cwd.length)
      : (file.filePath ?? '');
    for (const m of file.messages ?? []) {
      const sev = m.severity === 2 ? 'error' : 'warning';
      const rule = m.ruleId ?? '(no-rule)';
      const line = m.line ?? 0;
      const column = m.column ?? 0;
      console.log(`${rel}:${line}:${column}: ${sev} ${rule} ${m.message ?? ''}`);
    }
  }
}

const extraArgs = process.argv.slice(2);
const results = eslintJson(extraArgs) as PrintableFile[];
printMessages(results);

const actual = countWarningsByRule(results);
const total = lintWarningBudgetTotal();
console.log(
  `\nwarning ${Object.values(actual).reduce((a, b) => a + b, 0)} 件（予算合計 ${total}）`,
);
for (const [ruleId, count] of Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))) {
  const expected = LINT_WARNING_BUDGET[ruleId] ?? 0;
  console.log(`  ${ruleId}: ${count}（予算 ${expected}）`);
}

const violations = diffLintWarningBudget(actual);
const hasErrors = eslintJsonHasErrors(results);

if (violations.length > 0) {
  console.error('\nwarning のルール別予算と一致しません:');
  console.error(formatLintWarningBudgetViolations(violations));
  console.error(
    '\n正本は src/domain/governance/lint-warning-budget.ts の LINT_WARNING_BUDGET。' +
      '件数を下げたら予算も下げること。上げるのは PR に理由を書いたときだけ。',
  );
}

if (hasErrors) {
  console.error('\neslint が error を報告しています（warning 予算とは別）。');
}

if (violations.length > 0 || hasErrors) {
  process.exit(1);
}

console.log('warning 内訳は予算どおり');
