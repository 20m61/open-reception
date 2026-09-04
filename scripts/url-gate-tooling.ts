/**
 * `scripts/url-quality-gate.sh` の判定を担う CLI。
 *
 * bash 側は `command -v` / `docker info` / レポートファイルの有無を集めるだけの I/O 層に
 * とどめ、判定は `src/domain/governance/url-gate-tooling.ts`（純関数）に持たせる
 * ―― `scripts/aws-command-preflight.ts` と同じ形。
 *
 * ## サブコマンド
 *
 * ```
 *   url-gate-tooling.ts plan --strict=<0|1> dockerCli=<b> dockerDaemon=<b> chrome=<b>
 *       → `lighthouse=run` / `zap=skip\t<理由>` を 1 行ずつ
 *   url-gate-tooling.ts zap-exit <exitCode> <reportWritten:0|1>
 *       → `pass` | `high-risk` | `warn` | `unverified`
 * ```
 *
 * 出力を `key=value` とタブ区切りにしているのは、bash 側が `IFS` で素直に読めるため。
 * 理由文には**タブを含めない**（含めると bash 側の分解がずれる）。
 */
import {
  type UrlGateObservation,
  classifyZapExit,
  planUrlGateChecks,
} from '../src/domain/governance/url-gate-tooling';

function bail(message: string): never {
  console.error(`  ⛔ ${message}`);
  process.exit(2);
}

function parseBool(raw: string, label: string): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  bail(`${label} の値が true/false ではありません: ${raw}`);
}

function runPlan(argv: ReadonlyArray<string>): void {
  let strict = false;
  const observed: Record<string, boolean> = {};
  for (const arg of argv) {
    if (arg.startsWith('--strict=')) {
      strict = parseBool(arg.slice('--strict='.length), '--strict');
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) bail(`引数の形式が不正です（name=true|false ではありません）: ${arg}`);
    observed[arg.slice(0, eq)] = parseBool(arg.slice(eq + 1), arg.slice(0, eq));
  }

  // 🔴 **欠けている観測を「無し」で埋めない。** 既定値で埋めると、bash 側が観測を
  // 渡し忘れた変更が「その道具は無い」という**もっともらしい SKIP** に化けて、
  // 検査が静かに消える。判定不能は判定不能として止める。
  const required = ['dockerCli', 'dockerDaemon', 'chrome'] as const;
  const missing = required.filter((key) => !(key in observed));
  if (missing.length > 0) bail(`観測が足りません: ${missing.join(', ')}`);

  const observation: UrlGateObservation = {
    dockerCli: observed.dockerCli,
    dockerDaemon: observed.dockerDaemon,
    chrome: observed.chrome,
  };
  const plan = planUrlGateChecks(observation, { strict });
  for (const [name, disposition] of Object.entries(plan)) {
    if (disposition.kind === 'run') {
      console.log(`${name}=run`);
    } else {
      console.log(`${name}=${disposition.kind}\t${disposition.reason}`);
    }
  }
}

function runZapExit(argv: ReadonlyArray<string>): void {
  if (argv.length !== 2) bail('使い方: zap-exit <exitCode> <reportWritten:0|1>');
  const exitCode = Number(argv[0]);
  if (!Number.isInteger(exitCode)) bail(`終了コードが整数ではありません: ${argv[0]}`);
  console.log(classifyZapExit(exitCode, parseBool(argv[1], 'reportWritten')));
}

function main(): void {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === 'plan') return runPlan(rest);
  if (sub === 'zap-exit') return runZapExit(rest);
  bail(`未知のサブコマンド: ${sub ?? '(なし)'}（plan | zap-exit）`);
}

main();
