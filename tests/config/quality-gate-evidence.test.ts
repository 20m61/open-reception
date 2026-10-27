import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assessGateEvidence, parseGateEvidence } from '../../src/domain/governance/gate-evidence';
import { makeTempDir } from '../helpers/temp';

/**
 * `quality-gate.sh` が**実際に**証拠ファイルを書き、それが判定まで通ることを固定する (#1195)。
 *
 * 純関数（`gate-evidence.test.ts`）だけを縛ると、**ゲート側の配線**が抜けても全部緑のまま
 * になる（`.claude/rules/opus5-autonomous-loop.md`「棚卸しの対象を分岐に狭めない」）。
 * ここでは一時 git リポジトリでゲートを起動し、書かれたファイルを読んで判定まで通す。
 *
 * 本リポジトリで直接動かさないのは `quality-gate-stamp.test.ts` と同じ理由
 * （このツリーに偽の記録を残さない）。
 */
const REPO = process.cwd();

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** scripts/ だけを持つ、コミット済み・clean な一時リポジトリを作る。 */
function makeRepo(): { dir: string; head: string } {
  const dir = makeTempDir('gate-evidence-');
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  return { dir, head: git(dir, ['rev-parse', 'HEAD']) };
}

function runGate(
  dir: string,
  selftest: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): number {
  try {
    execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--full', '--no-bootstrap', ...extraArgs], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QUALITY_GATE_SELFTEST: selftest, ...extraEnv },
    });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

function evidencePath(dir: string): string {
  return join(dir, '.git', 'open-reception-gate-evidence-full');
}

vi.setConfig({ testTimeout: 30_000 });

describe('quality-gate: --full の証拠ファイル (#1195)', () => {
  it('完走・PASS・clean なら、head に紐づいた PASS の証拠を書く（判定まで通す）', () => {
    const { dir, head } = makeRepo();
    expect(runGate(dir, 'pass')).toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence).toMatchObject({
      tier: 'full',
      exitCode: 0,
      stamped: true,
      headAtStart: head,
      headAtEnd: head,
      dirtyAtStart: false,
      dirtyAtEnd: false,
    });
    expect(evidence.steps).toContainEqual({ status: 'PASS', label: 'selftest step', detail: '' });
    expect(evidence.environment.map(([k]) => k)).toEqual(
      expect.arrayContaining(['runner', 'os', 'node', 'gitleaks', 'semgrep']),
    );
    expect(evidence.plan.get('e2e')).toBe('1');
    expect(evidence.selftest).toBe('pass');
    // 🔴 seam で起動した実行は PASS にならない（ステップを走らせていない）。
    // 下界として、**それ以外の理由が 1 つも無い**ことを見る ―― 配線（head・dirty・exit・
    // スタンプ・計画）が生きていれば、本物の実行ではこの証拠が PASS になる。
    expect(assessGateEvidence(evidence, head)).toEqual({
      passed: false,
      reasons: ['自己テスト用の seam（pass）で起動した実行で、ステップを走らせていない'],
    });
  });

  it('検査できなかったステップがあれば exit 1・スタンプ無しとして書く', () => {
    const { dir, head } = makeRepo();
    expect(runGate(dir, 'unverified')).not.toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence).toMatchObject({ exitCode: 1, stamped: false });
    expect(assessGateEvidence(evidence, head).passed).toBe(false);
  });

  it('FAIL したステップがあれば exit 1・スタンプ無しとして書く', () => {
    // --strict の下では任意ツールの未導入が FAIL になる（FAILED=1 の終了経路を通す）。
    const { dir, head } = makeRepo();
    expect(runGate(dir, 'optional', ['--strict'])).toBe(1);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence).toMatchObject({ exitCode: 1, stamped: false });
    expect(evidence.steps.some((s) => s.status === 'FAIL')).toBe(true);
    expect(assessGateEvidence(evidence, head).passed).toBe(false);
  });

  /**
   * 🔴 **終了時の値は終了時に測る。** 開始時の値を写すと、実行中の編集やコミットが見えない。
   * 実行の途中で任意のコマンドを走らせられる seam（change-risk の検出器）で、ゲートの
   * 最中にツリーを変える。
   */
  it('🔴 実行中に作業ツリーを変えたら、終了時の dirty として書く', () => {
    const { dir, head } = makeRepo();
    expect(
      runGate(dir, 'change-risk-invoke', [], { QUALITY_GATE_DETECTOR_CMD: 'echo x > late.txt' }),
    ).toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence).toMatchObject({ dirtyAtStart: false, dirtyAtEnd: true });
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/終了時の作業ツリーが dirty/);
  });

  it('🔴 実行中に HEAD が動いたら、終了時の HEAD として書く', () => {
    const { dir, head } = makeRepo();
    const commit =
      'git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m moved';
    expect(runGate(dir, 'change-risk-invoke', [], { QUALITY_GATE_DETECTOR_CMD: commit })).toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.headAtStart).toBe(head);
    expect(evidence.headAtEnd).toBe(git(dir, ['rev-parse', 'HEAD']));
    expect(evidence.headAtEnd).not.toBe(head);
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/HEAD が動いた/);
  });

  it('🔴 未追跡ファイルがあれば dirty として書く（コミットしていない変更で PASS させない）', () => {
    const { dir, head } = makeRepo();
    writeFileSync(join(dir, 'uncommitted.ts'), 'export {};\n');
    expect(runGate(dir, 'pass')).toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence).toMatchObject({ dirtyAtStart: true, dirtyAtEnd: true });
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/dirty/);
  });

  it('🔴 終了処理に届かなかった実行は、前回の PASS の証拠を残さない', () => {
    const { dir, head } = makeRepo();
    expect(runGate(dir, 'pass')).toBe(0);
    expect(parseGateEvidence(readFileSync(evidencePath(dir), 'utf8')).exitCode).toBe(0);

    // 知らない seam 値は finish() を通らずに exit 2 で終わる（= 途中で死んだ実行の代わり）。
    expect(runGate(dir, 'no-such-selftest')).toBe(2);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.exitCode).toBeNull();
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/完走していない/);
  });

  it('🔴 測る対象を差し替える環境変数は、値を書かずに在否だけを書く', () => {
    const { dir, head } = makeRepo();
    expect(
      runGate(dir, 'pass', [], {
        PLAYWRIGHT_BASE_URL: 'http://TEST-elsewhere.invalid',
        QUALITY_GATE_DETECTOR_CMD: 'exit 0',
      }),
    ).toBe(0);
    const text = readFileSync(evidencePath(dir), 'utf8');
    expect(text).not.toContain('TEST-elsewhere');
    const evidence = parseGateEvidence(text);
    expect([...evidence.overrides].sort()).toEqual(['PLAYWRIGHT_BASE_URL', 'QUALITY_GATE_DETECTOR_CMD']);
    expect(assessGateEvidence(evidence, head).passed).toBe(false);
  });

  /**
   * 🔴 **flaky を数える配線そのもの**を通す。集計の出力は playwright の実際の形に揃え、
   * テスト名に "flaky" を含む行（数えてはいけない）も混ぜる。
   */
  it.each([
    ['1 件', '  ✓  3 [chromium-ipad] › a.spec.ts:1:1 › flaky な描画を待つ (1.0s)\n  1 flaky\n    [chromium-ipad] › b.spec.ts:2:2 › x\n  606 passed (10.6m)\n', '1 件が retry で通った'],
    // 🔴 テスト名の「2 flaky」を集計と取り違えない（行頭・行末の錨の下界）。
    ['0 件（テスト名に「N flaky」を含む）', '  ✓  3 [chromium-ipad] › a.spec.ts:1:1 › retries 2 flaky tests (1.0s)\n  607 passed (10.6m)\n', null],
    // 色付きの集計（FORCE_COLOR）も数える。
    ['色付きの 2 件', '  \u001b[33m  2 flaky\u001b[39m\n  \u001b[32m  605 passed\u001b[39m\u001b[2m (10.6m)\u001b[22m\n', '2 件が retry で通った'],
    // 🔴 集計行が無い（github reporter 等）なら「数えられなかった」として PASS と認めない。
    ['集計が読めない', '::notice title=🎭 Playwright Run Summary::  2 flaky%0A  605 passed (10.6m)\n', '集計を読めず flaky を数えられなかった'],
  ] as const)('e2e が retry で通ったら FLAKY の行を書き、PASS と認めない（%s）', (_n, fixture, count) => {
    const { dir, head } = makeRepo();
    const file = join(dir, '..', `e2e-${Math.random().toString(36).slice(2)}.log`);
    writeFileSync(file, fixture);
    expect(runGate(dir, 'e2e-flaky', [], { QUALITY_GATE_E2E_FIXTURE: file })).toBe(0);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.steps).toContainEqual(expect.objectContaining({ status: 'PASS', label: 'e2e (playwright)' }));
    const flaky = evidence.steps.filter((s) => s.status === 'FLAKY');
    if (count === null) {
      expect(flaky).toEqual([]);
    } else {
      expect(flaky).toEqual([
        { status: 'FLAKY', label: 'e2e (playwright)', detail: count },
      ]);
      expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/^FLAKY: e2e/m);
    }
  });

  it('🔴 flaky を数える包みは、e2e の失敗をそのまま失敗として返す', () => {
    // 集計を tee で読むために包んでいる。包みが終了コードを握り潰すと、e2e の赤が緑になる。
    const { dir } = makeRepo();
    const missing = join(dir, '..', 'no-such-e2e-output.log');
    expect(runGate(dir, 'e2e-flaky', [], { QUALITY_GATE_E2E_FIXTURE: missing })).toBe(1);
    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.steps).toContainEqual(expect.objectContaining({ status: 'FAIL', label: 'e2e (playwright)' }));
  });

  it('--no-build を付けた --full は、計画から build が落ちたことを書く', () => {
    const { dir, head } = makeRepo();
    expect(runGate(dir, 'pass', ['--no-build'])).toBe(0);
    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.plan.get('build')).toBe('0');
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/実行計画に入っていない: build/);
  });

  it('--full の証拠は後から回した --fast に上書きされない（tier ごとに別ファイル）', () => {
    const { dir } = makeRepo();
    expect(runGate(dir, 'pass')).toBe(0);
    const before = readFileSync(evidencePath(dir), 'utf8');
    execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--fast', '--no-bootstrap'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QUALITY_GATE_SELFTEST: 'pass' },
    });
    expect(existsSync(join(dir, '.git', 'open-reception-gate-evidence-fast'))).toBe(true);
    expect(readFileSync(evidencePath(dir), 'utf8')).toBe(before);
  });
});
