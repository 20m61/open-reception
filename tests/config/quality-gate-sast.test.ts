/**
 * SAST（semgrep）の**ルールセット供給**の配線 (#841)。
 *
 * ## なぜ要るか
 *
 * 以前の sast ステップは `--config p/default` で、実行のたびに `semgrep.dev` を引いていた。
 * 外向き通信が制限された環境では、**semgrep が導入済みでも sast は実行できない**
 * （実測: `curl https://semgrep.dev/c/p/default` が CONNECT 403）。`CLAUDE.md` は
 * `--pr` / `--full` をクラウド既定としているので、方針上の正規経路でマージ前ゲートが
 * 取れないという形で効いていた。加えてレジストリのルールは外側で更新されるため、
 * 同じツリーに対する結果が日によって変わりうる（決定性が無い）。
 *
 * ## ここで縛る不変条件
 *
 * 分岐ごとの期待値ではなく次を縛る（`CLAUDE.md`「検証の作法」）。
 *
 * - **上界**: sast が green として**記録された**なら、semgrep はローカルのルールセットを
 *   読んで走っている（レジストリを引いていない）
 * - **下界**: ルールが揃っていれば実際に記録される。これが無いと「全部を判定不能に倒す」
 *   実装でも上界だけ空虚に満たせる
 *
 * 「ルールを読めなかった」を**指摘ゼロと同じ緑にしない**ことが本体（AC4）。`skip_or_fail` に
 * 倒すと SKIP のまま exit 0 で記録が残り、#640（infra synth が 45 件 SKIP のまま tier=full を
 * 記録し pr-gate-guard がマージを許した）と同じ被害になる。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const REPO = process.cwd();
const RULES_DIR = 'semgrep-rules';

type GateResult = {
  status: number;
  stdout: string;
  stamp: string;
  /** スタブ semgrep が受け取った argv の全記録（呼ばれなければ空文字）。 */
  semgrepArgs: string;
};

/** 既定のスタブ出力。`semgrep --test` が「実際にテストを走らせた」形。 */
const TESTS_RAN = '2/2: ✓ All tests passed';
/** テストが 1 件も見つからなかったときの semgrep の実出力（**exit 0 を返す**）。 */
const NO_TESTS = 'No unit tests found. See https://semgrep.dev/docs/writing-rules/testing-rules';

function runSast(options: {
  /** `null` でルールディレクトリ自体を作らない。 */
  rules?: Record<string, string> | null;
  /** `semgrep --test` の標準出力。 */
  testOutput?: string;
  /** `semgrep scan` の終了コード。 */
  scanExit?: number;
}): GateResult {
  const dir = mkdtempSync(join(tmpdir(), 'gate-sast-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/sast.sh'), join(dir, 'scripts/sast.sh'));
  chmodSync(join(dir, 'scripts/sast.sh'), 0o755);
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));

  const rules = options.rules === undefined ? { 'base.yaml': 'rules: []\n' } : options.rules;
  if (rules !== null) {
    mkdirSync(join(dir, RULES_DIR), { recursive: true });
    for (const [name, body] of Object.entries(rules)) {
      writeFileSync(join(dir, RULES_DIR, name), body);
    }
  }

  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

  const argsLog = join(dir, 'semgrep-args.txt');
  {
    writeFileSync(
      join(dir, 'bin', 'semgrep'),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> ${JSON.stringify(argsLog)}
case "$1" in
  --test) printf '%s\\n' ${JSON.stringify(options.testOutput ?? TESTS_RAN)}; exit 0 ;;
  scan)   exit ${options.scanExit ?? 0} ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
  }
  writeFileSync(join(dir, 'bin', 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'npx'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--sast', '--no-bootstrap'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? '';
  }

  const stampPath = join(dir, '.git', 'open-reception-gate-stamp');
  const result: GateResult = {
    status,
    stdout,
    stamp: existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : '',
    semgrepArgs: existsSync(argsLog) ? readFileSync(argsLog, 'utf8') : '',
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// 子プロセスを実走するので、並行実行下では既定の 5s ではアサーションに到達できない
// （quality-gate-scope.test.ts / aws-*.test.ts と同じ理由・同じ扱い）。
vi.setConfig({ testTimeout: 30_000 });

describe('quality-gate: sast のルールセット供給 (#841)', () => {
  it('下界: ルールが揃っていれば sast は PASS として記録される', () => {
    // これが無いと、下の「レジストリを引かない」は**全部を判定不能に倒す**実装でも
    // 空虚に満たせる。緑になる経路が実在することを先に固定する。
    const r = runSast({});
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ {2}PASS {2}sast \(semgrep\)/m);
    expect(r.stamp).not.toBe('');
  });

  it('🔴 レジストリ（p/…）を引かない', () => {
    // #841 の本体。ここが破れると遮断環境で恒久的に実行できない。
    const r = runSast({});
    expect(r.semgrepArgs).not.toBe('');
    expect(r.semgrepArgs).not.toMatch(/(^|\n)p\/\w/);
    expect(r.semgrepArgs).not.toContain('semgrep.dev');
  });

  it('🔴 ローカルのルールディレクトリを --config に渡す', () => {
    const lines = runSast({}).semgrepArgs.split('\n');
    const idx = lines.indexOf('--config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines[idx + 1]).toContain(RULES_DIR);
  });

  it('🔴 ルールセットが無いとき「指摘ゼロ」と区別する（green にしない）', () => {
    const r = runSast({ rules: null });
    expect(r.stdout).toMatch(/^ {2}SKIP {2}sast \(semgrep\)/m);
    expect(r.stamp).toBe('');
    expect(r.semgrepArgs).toBe('');
  });

  it('🔴 ディレクトリだけ在って yaml が無いときも同じ扱い', () => {
    // 存在検査だけだと「ルール 0 件で 0 findings」＝ green という最悪の素通りになる。
    const r = runSast({ rules: { 'README.md': 'not a rule\n' } });
    expect(r.stdout).toMatch(/^ {2}SKIP {2}sast \(semgrep\)/m);
    expect(r.stamp).toBe('');
    expect(r.semgrepArgs).toBe('');
  });

  it('🔴 ルールの自己テストが 1 件も走らなかったら green にしない', () => {
    // `semgrep --test` は**テストが見つからなくても exit 0** を返す（実測）。
    // 終了コードだけを見ていると、ルールが空虚になっても緑のままになる。
    const r = runSast({ testOutput: NO_TESTS });
    expect(r.stdout).toMatch(/^ {2}SKIP {2}sast \(semgrep\)/m);
    expect(r.stamp).toBe('');
    // 走査まで進んでいないこと（＝ scan の 0 findings を根拠にしていない）。
    expect(r.semgrepArgs).not.toContain('scan');
  });

  it('🔴 semgrep 未導入は「持っていない」SKIP のまま（検査できなかった側へ移さない）', () => {
    // 2 つの SKIP は意味が違う。任意ツールの未導入は docs/quality-gate.md が既定として
    // 許容しており記録も残る（skip_or_fail）。一方「ルールを読めなかった」は記録を拒否する
    // （skip_unverified）。取り違えると、#838 の「静かに素通り」を増やすか、
    // 逆に semgrep を持たない開発者のゲートが恒久的に記録できなくなる。
    //
    // 🔴 **実走では縛れない。** `command -v semgrep` は PATH 上の実物を見つけるので、
    // スタブを置かないだけでは「未導入」を再現できない。PATH から実物を除くと今度は
    // テストが実行環境の配置に強く結合し、#838 と同じ「環境起因の赤」を持ち込む。
    // よってここは**分岐の取り違えだけ**をソース契約として固定する（限界を明記した上で）。
    const gate = readFileSync(resolve(REPO, 'scripts/quality-gate.sh'), 'utf8');
    const start = gate.indexOf('if [[ "$RUN_SAST" -eq 1 ]] && scope_skips sast');
    const end = gate.indexOf('if [[ "$RUN_AUDIT" -eq 1 ]]', start);
    expect(start, 'sast のブロックが見つからない（名前が変わった？）').toBeGreaterThan(0);
    expect(end, 'sast ブロックの終端が見つからない').toBeGreaterThan(start);
    const sastBlock = gate.slice(start, end);
    expect(sastBlock).toContain('skip_or_fail "sast (semgrep)" "semgrep not installed"');
    expect(sastBlock).not.toContain('skip_unverified "sast (semgrep)" "semgrep not installed"');
  });

  it('semgrep が指摘を出したら FAIL する', () => {
    const r = runSast({ scanExit: 1 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/^ {2}FAIL {2}sast \(semgrep\)/m);
    expect(r.stamp).toBe('');
  });
});

describe('リポジトリに実在するルールセット (#841)', () => {
  // 上のケースは一時 repo に自前で作ったルールを使うので、**本物が消えても緑のまま**。
  // 実ファイルに対する契約はここで別に固定する。
  const dir = resolve(REPO, RULES_DIR);

  it('ルールが実在する', () => {
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.yaml')).length).toBeGreaterThan(0);
  });

  it('🔴 ルールは .yaml で置く（.yml だと自己テストが黙って無効になる）', () => {
    // semgrep のテスト探索は `.yaml` しか見ない。`.yml` に改名すると
    // 「テスト 0 件」で exit 0 になり、**ルールが壊れても気づけない**（実測）。
    expect(readdirSync(dir).filter((f) => f.endsWith('.yml'))).toEqual([]);
  });

  it('🔴 ルールディレクトリはドット始まりにしない（探索から丸ごと除外される）', () => {
    // 当初 `.semgrep/` に置いていて踏んだ。隠しディレクトリは semgrep --test の
    // 探索対象外で、これも「テスト 0 件・exit 0」に倒れる。
    expect(basename(dir).startsWith('.')).toBe(false);
  });

  it('🔴 すべてのルールに同名のフィクスチャがある（空虚なルールを置かない）', () => {
    // フィクスチャが無いルールは `semgrep --test` に検査されないので、
    // 「何にも当たらないルール」でも緑のまま増やせてしまう。
    const files = readdirSync(dir);
    const rules = files.filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));
    const missing = rules.filter((name) => !files.includes(`${name}.ts`));
    expect(missing).toEqual([]);
  });

  it('🔴 フィクスチャは検出側と非検出側の両方を持つ（下界を縛る）', () => {
    // `ruleid:` だけだと「全部に当たる」ルールでも通る。`ok:` を必ず併記させる。
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, `${f} に ruleid: 注釈が無い`).toMatch(/^\s*\/\/\s*ruleid:/m);
      expect(text, `${f} に ok: 注釈が無い`).toMatch(/^\s*\/\/\s*ok:/m);
    }
  });
});
