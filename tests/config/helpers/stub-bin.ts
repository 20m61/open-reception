/**
 * 外部コマンドを差し替えた PATH でスクリプトを起動するための小道具 (#1117)。
 *
 * ## なぜ要るか
 *
 * ソースを grep するテストは「呼び出しが残っているか」を見られない。実測で、
 * 作成後の引き直しを丸ごと消す変異も、`evaluate-gate-runs.ts` の失敗を
 * 「取りこぼし無し」と読む変異も、**リポジトリ全体のテストを素通り**した。
 *
 * 見たいのは**倒れ方**なので、`curl` と `git` を偽物へ差し替え、
 * スクリプトを本当に起動して終了コードと出力を観測する。
 * `gh` は「呼ばれたら失敗する」偽物を置き、`gh` へ戻る退行を PATH の側から捕まえる。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../../helpers/temp';

/** 1 回分の応答。`curl -w '\n%{http_code}'` と同じ形（本文 + 改行 + 状態コード）で返す。 */
export type StubResponse = { body: string; status: number };

export type StubRun = { code: number; stdout: string; stderr: string; dir: string };

export type StubOptions = {
  /** `curl` が順に返す応答。尽きたら 500 を返す。 */
  readonly responses?: ReadonlyArray<StubResponse>;
  /** `curl` を必ず失敗させる（通信不能の再現）。`responses` より優先。 */
  readonly curlFailsWith?: number;
  /** `git <サブコマンド>` に対する標準出力。指定が無いサブコマンドは空・成功。 */
  readonly git?: Readonly<Record<string, string>>;
  /** 追加の環境変数。 */
  readonly env?: Readonly<Record<string, string>>;
};

/** `npx` はレジストリ解決の分だけ余計に待つ。ローカルの tsx を直接呼ぶ。 */
const TSX = join('node_modules', '.bin', 'tsx');

/** 子プロセスで TypeScript を起動するので、既定の 5 秒では負荷下で足りない。 */
export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * 作った砂場。**必ず片付ける** —— 実測で 1 実行あたり 29 ディレクトリが `/tmp` に残った。
 * #721（`/tmp/cdk.out*` が 740 個・26GB まで積もり、メモリも load も正常なまま
 * e2e が `Target crashed` で落ちた）の前例がある。呼び出し側は
 * `afterAll(cleanupStubDirs)` を 1 行書く。
 */
const createdDirs: string[] = [];

export function cleanupStubDirs(): void {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/**
 * 偽の `curl` / `gh`（と必要なら `git`）を置いた PATH でスクリプトを起動する。
 *
 * 🔴 **偽 `curl` は `--config -` が argv にあるときだけ stdin を読む。**
 * 無条件に読むと、**config を渡さなくなる変異でも stdin にデータが残り**、
 * 「stdin で秘密を渡している」という主張が空虚に通る（実測で確認した欠陥）。
 */
export function runScriptWithStubs(script: string, args: string[], options: StubOptions = {}): StubRun {
  const dir = makeTempDir('stub-bin-');
  createdDirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);

  (options.responses ?? []).forEach((r, i) => {
    writeFileSync(join(dir, `response-${i + 1}`), `${r.body}\n${r.status}`);
  });

  const curlBody =
    options.curlFailsWith !== undefined
      ? `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "curl stub"; exit 0; fi
printf '%s\\n' "$*" >> "${dir}/argv.log"
echo "curl: (stub) simulated transport failure" >&2
exit ${options.curlFailsWith}
`
      : `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "curl stub"; exit 0; fi
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "${dir}/count"
printf '%s\\n' "$*" >> "${dir}/argv.log"
# --config - を渡されたときだけ stdin を読む（渡さない変異を生かさないため）。
case "$*" in *"--config -"*) cat > "${dir}/stdin-$n" ;; esac
if [ -f "${dir}/response-$n" ]; then cat "${dir}/response-$n"; else printf 'no stub response\\n500'; fi
`;
  writeExecutable(join(bin, 'curl'), curlBody);

  writeExecutable(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "gh was invoked: $*" >> "${dir}/gh.log"
exit 127
`,
  );

  if (options.git !== undefined) {
    // 🔴 **出力はファイルへ書いて `cat` する。** シェルへ埋めると、タブや改行が
    // `printf '%s'` では展開されずリテラルの `\t` / `\n` として渡り、
    // `git ls-remote --symref` の出力が**黙って 0 行にパースされる**（実際に踏んだ）。
    const cases = Object.entries(options.git)
      .map(([sub, out], i) => {
        const file = join(dir, `git-out-${i}`);
        writeFileSync(file, out);
        return `  *"${sub}"*) cat ${JSON.stringify(file)} ;;`;
      })
      .join('\n');
    writeExecutable(
      join(bin, 'git'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/git.log"
case "$*" in
${cases}
  *) : ;;
esac
exit 0
`,
    );
  }

  try {
    const stdout = execFileSync(TSX, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OPEN_RECEPTION_SKIP_GATE_GUARD: '1',
      },
    });
    return { code: 0, stdout, stderr: '', dir };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', dir };
  }
}

export function readLog(dir: string, name: string): string {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return '';
  }
}
