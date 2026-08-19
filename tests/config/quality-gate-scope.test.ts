/**
 * 変更範囲による省略の**シェル側**の配線 (#712)。
 *
 * ## なぜ要るか
 *
 * 判定は `src/domain/governance/change-scope.ts`（純関数）と `scripts/change-scope.ts`
 * （`tests/hooks/change-scope.test.ts` が実走で固定）にある。**残る危険は配線**で、
 * `quality-gate.sh` が出力をどう読むかが誰にも縛られていなかった。
 *
 * #709 / #712 が繰り返し踏んでいるのがまさにこれ ——「判定は正しいのに、それが機械へ
 * 伝わる経路が黙って落ちる」。落ちたときの症状は**検証を飛ばしたまま green**。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

/**
 * scripts/ だけを持つ一時 git リポジトリでゲートを動かし、change-scope の出力を差し替える。
 *
 * `exitCode` を非 0 にすると、`quality-gate.sh` のフォールバック（`|| echo "scope=code"`）が
 * **後から**流れる状況を作れる。
 */
function runGate(options: { scopeOutput: string; exitCode?: number }): {
  status: number;
  stdout: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gate-scope-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  writeFileSync(
    join(dir, 'bin', 'npx'),
    `#!/usr/bin/env bash
case "$*" in
  *--version*) exit 0 ;;
  *" -e "*) printf ''; exit 0 ;;
  *change-scope.ts*) printf '%b\\n' ${JSON.stringify(options.scopeOutput)}; exit ${options.exitCode ?? 0} ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'bin', 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--pr', '--no-bootstrap'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? '';
  }
  return { status, stdout };
}

describe('quality-gate: 変更範囲の読み取り配線 (#712)', () => {
  it('docs 判定なら省略する（既存の契約）', () => {
    const { stdout } = runGate({ scopeOutput: 'scope=docs\nskip=build' });
    expect(stdout).toContain('SKIP  build (next build)');
  });

  it('🔴 判定が code に倒れたら、直前に読んだ skip を引きずらない', () => {
    // `change-scope.ts` が scope=docs と skip=build を印字した**後**に死ぬと、
    // フォールバックの `echo "scope=code"` が後から流れて GATE_SCOPE は code に戻る。
    // このとき GATE_SKIPS が残っていると「code なのに build を省略した」まま green になる
    // ——#712 が塞ごうとした被害（未検証ツリーが green）とまったく同じ。
    const { stdout } = runGate({ scopeOutput: 'scope=docs\nskip=build\nskip=e2e', exitCode: 1 });
    expect(stdout).not.toContain('SKIP  build (next build)');
    expect(stdout).not.toContain('code-scope');
  });

  it('🔴 note= を読み取ってゲート出力に見せる', () => {
    // 「測れなかったので省略しなかった」は scope=code なので、ここで拾わないと
    // **完全に不可視**になる（code のときシェルは change-scope のブロックを出さない）。
    const { stdout } = runGate({ scopeOutput: 'scope=code\nnote=収集に失敗しました' });
    expect(stdout).toContain('判定の但し書き');
    expect(stdout).toContain('収集に失敗しました');
  });

  it('note が無ければ但し書きの節を出さない（常態化させない）', () => {
    const { stdout } = runGate({ scopeOutput: 'scope=code' });
    expect(stdout).not.toContain('判定の但し書き');
  });
});
