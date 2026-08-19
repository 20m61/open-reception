/**
 * 委譲プロンプト生成器がゲートスタンプで申告を裏取りすることを固定する (#711)。
 *
 * ## なぜ実走で縛るのか
 *
 * 判定は純関数側（`src/domain/governance/gate-stamp-check.ts`）でユニットテスト済み。
 * **危ないのは配線**で、スクリプトがスタンプを読まなくなっても、あるいはチェックの
 * 結果を無視しても、ドメインのテストは全部 green のままになる。
 * この一連の周回で同じ型を何度も踏んでいる。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const SPEC = {
  branch: 'fix/x',
  headSha: 'abc1234',
  baseSha: 'def5678',
  title: 'fix(x): y',
  summary: 's',
  changedFiles: ['a.ts'],
  refs: [711],
};

/**
 * scripts/ と domain だけを持つ一時 git リポジトリでスクリプトを走らせる。
 *
 * `stamp` に文字列を渡すと、その内容でスタンプを置く（`null` なら置かない＝記録なし）。
 */
function run(options: {
  localFastGate: string;
  stamp: 'matching' | 'mismatched' | 'none';
}): { status: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'delegate-prompt-'));
  created.push(dir);
  for (const rel of ['scripts', 'src/domain/governance']) mkdirSync(join(dir, rel), { recursive: true });
  cpSync(resolve(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(resolve(REPO, 'src'), join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });

  if (options.stamp !== 'none') {
    const fingerprint =
      options.stamp === 'matching'
        ? execFileSync('bash', ['-c', '. scripts/lib/gate-stamp.sh && gate_tree_fingerprint'], {
            cwd: dir,
            encoding: 'utf8',
          }).trim()
        : 'deadbeef'.repeat(8);
    writeFileSync(
      join(dir, '.git', 'open-reception-gate-stamp'),
      `fast\t${fingerprint}\t2026-08-19T00:00Z\tcode\n`,
    );
  }

  // 🔴 **spec はリポジトリの外へ置く。** 中に置くと指紋が変わり、
  // 「一致する記録」を作ったつもりが一致しなくなる（実際に踏んだ）。
  const specDir = mkdtempSync(join(tmpdir(), 'delegate-spec-'));
  created.push(specDir);
  const specPath = join(specDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ ...SPEC, localFastGate: options.localFastGate }));
  const result = spawnSync(
    resolve(REPO, 'node_modules/.bin/tsx'),
    [join(dir, 'scripts/delegate-gate-prompt.ts'), specPath],
    { cwd: dir, encoding: 'utf8' },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

describe('delegate-gate-prompt.ts: 申告をスタンプで裏取りする (#711)', () => {
  it('🔴 green と申告されたのに一致する記録が無ければ非 0 で止まる', () => {
    // spec に green と書けば #705 の事象はそのまま再現する ——「申告の誠実性に依存」を塞ぐ。
    const r = run({ localFastGate: 'green', stamp: 'mismatched' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('green 記録がありません');
    // 本文を出さない（嘘の前提を委譲先へ渡さない）。
    expect(r.stdout).not.toContain('## 手順');
  }, 120_000);

  it('green と申告され一致する記録があれば通る', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
  }, 120_000);

  it('🔴 記録が無い（判定不能）ときは通す（「測れなかった」を「嘘だった」に倒さない）', () => {
    // ここで落とすと #705 と同じ型の誤りを逆向きに作ることになる。
    const r = run({ localFastGate: 'green', stamp: 'none' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('裏取りできませんでした');
    expect(r.stdout).toContain('## 手順');
  }, 120_000);

  it('not-run の申告は裏取りの対象にしない', () => {
    const r = run({ localFastGate: 'not-run', stamp: 'mismatched' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
  }, 120_000);
});
