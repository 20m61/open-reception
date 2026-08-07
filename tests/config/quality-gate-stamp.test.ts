import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「検証できなかったステップ」があるとき green として**記録しない**ことを固定する (#640)。
 *
 * ## 何が起きたか
 *
 * `--full` が `infra WebStack synth`（45 件）を SKIP したまま **exit 0** で終わり、
 * `✅ quality-gate PASSED (tier=full を green として記録しました)` と表示していた。
 * この記録は `scripts/hooks/pr-gate-guard.sh` がマージ許可の根拠に使うため、
 * **45 件が走っていない状態でマージが通る**。2026-08-07 の 1 周回で 2 回踏んだ。
 *
 * ## SKIP には 2 種類ある
 *
 * - **任意ツール未導入**（gitleaks/semgrep/lhci が無い）… 従来どおり許容して green。
 *   `docs/quality-gate.md` の既定であり、`--strict` で FAIL にできる。
 * - **前提が壊れていて検査できなかった**（`.open-next` が stale 等）… green の根拠を欠く。
 *   「落ちなかった」だけで「通った」ではないので、**記録を拒否する**。
 *
 * ## なぜ実際に起動するのか
 *
 * 字面を grep するテストはリファクタで簡単に嘘になる（`quality-gate-tiers.test.ts` と
 * 同じ理由）。ここは **exit code と、スタンプファイルが実際に書かれたか**という
 * 副作用で判定する。
 *
 * ## なぜ一時 git リポジトリで動かすのか
 *
 * スタンプは `git rev-parse --absolute-git-dir` 配下に書かれる。本リポジトリで
 * 直接動かすと**このツリーに対する偽の green 記録を残してしまい**、テストが
 * 「マージしてよい」と嘘をつく状態を作る。必ず隔離する。
 */
const REPO = process.cwd();

/** scripts/ だけを持つ一時 git リポジトリを作り、その中で quality-gate.sh を動かす。 */
function runIsolated(selftest: string): {
  status: number;
  stdout: string;
  stampExists: boolean;
  stamp: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gate-stamp-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--full', '--no-bootstrap'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, QUALITY_GATE_SELFTEST: selftest },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? '';
  }

  const stampPath = join(dir, '.git', 'open-reception-gate-stamp');
  const stampExists = existsSync(stampPath);
  return {
    status,
    stdout,
    stampExists,
    stamp: stampExists ? readFileSync(stampPath, 'utf8') : '',
  };
}

describe('quality-gate: 検証できなかったステップは green にしない (#640)', () => {
  it('前提が壊れて検査できなかったとき、green として記録せず非 0 で終わる', () => {
    const r = runIsolated('unverified');

    // 🔴 ここが #640 の本体。**スタンプを書かせない**のが要点で、
    // exit code だけ直しても pr-gate-guard は記録を見るので素通りする。
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it('「検証できなかった」ことが理由付きで出力される（黙って落とさない）', () => {
    const r = runIsolated('unverified');
    // 何が検証できなかったのかが読めること。ラベルが出ないと原因追跡ができない。
    expect(r.stdout).toContain('selftest step');
    // 「PASSED」と誤読させないこと。これが今回の事故そのもの。
    expect(r.stdout).not.toMatch(/✅ quality-gate PASSED/);
  });

  it('任意ツール未導入の SKIP は従来どおり green（既定の契約を壊さない）', () => {
    const r = runIsolated('optional');
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
    expect(r.stamp).toMatch(/^full\t/);
  });

  it('全ステップ PASS なら green として記録する', () => {
    const r = runIsolated('pass');
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
  });
});
