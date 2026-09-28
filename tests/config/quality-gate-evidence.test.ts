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
      expect.arrayContaining(['runner', 'os', 'node']),
    );
    // 🔴 下界: 配線が生きていれば、この証拠は PR の head と一致するとき PASS になる。
    expect(assessGateEvidence(evidence, head)).toEqual({ passed: true, reasons: [] });
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
    expect(assessGateEvidence(parseGateEvidence(readFileSync(evidencePath(dir), 'utf8')), head).passed).toBe(true);

    // 知らない seam 値は finish() を通らずに exit 2 で終わる（= 途中で死んだ実行の代わり）。
    expect(runGate(dir, 'no-such-selftest')).toBe(2);

    const evidence = parseGateEvidence(readFileSync(evidencePath(dir), 'utf8'));
    expect(evidence.exitCode).toBeNull();
    expect(assessGateEvidence(evidence, head).reasons.join('\n')).toMatch(/完走していない/);
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
