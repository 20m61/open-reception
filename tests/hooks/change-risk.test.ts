/**
 * `scripts/change-risk.ts` の振る舞い検証 (#709)。
 *
 * ## なぜ実走で縛るのか
 *
 * 判定そのものは純関数側（`src/domain/governance/change-risk.ts` /
 * `git-base.ts`）でユニットテスト済み。**危ないのは配線**で、スクリプトが
 * `measurement` を渡さなくなっても、あるいは判定保留の分岐を落としても、
 * ドメインのテストは全部 green のままになる。
 *
 * そして落ちたときの症状が**沈黙**（「停止境界に触れていません」と断定する）なので、
 * 気づく手立てが要る。#709 はまさにその形だった。
 *
 * ## どう再現するか
 *
 * `git diff` **だけ**を失敗させる shim を PATH の先頭に置く。起点が壊れた場合は
 * manifest 読みも同時に壊れて別の症状（全依存を「追加」と誤検出する過大報告）になり、
 * 過小報告を分離できないため、この形で確かめる。実環境では浅い clone や、
 * メモリ枯渇による散発的な失敗で起こりうる。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(process.cwd(), 'scripts/change-risk.ts');

/** shim を置く前に本物の git の場所を控える（shim が自分自身を呼ばないように）。 */
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

/** 判定の起点。**実在する ref を pin する**（起点解決の揺れを持ち込まない）。 */
const HEAD_SHA = execFileSync(REAL_GIT, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/** `git diff` だけを失敗させる shim を作り、そのディレクトリを返す。 */
function makeFailingDiffShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'change-risk-shim-'));
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    `#!/bin/bash\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then\n    echo "fatal: simulated failure" >&2\n    exit 128\n  fi\ndone\nexec ${REAL_GIT} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

function run(extraPath?: string): string {
  const result = spawnSync('npx', ['tsx', CLI], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GATE_BASE_SHA: HEAD_SHA,
      ...(extraPath === undefined ? {} : { PATH: `${extraPath}:${process.env.PATH ?? ''}` }),
    },
  });
  return result.stdout ?? '';
}

const ASSERTION = '停止境界に触れていません';

describe('scripts/change-risk.ts: 測れていないことを断定しない (#709)', () => {
  it('🔴 git diff が失敗したら、触れていないと断定せず判定保留にする', () => {
    const stdout = run(makeFailingDiffShim());
    // これが #709 の本体。修正前はここで「停止境界に触れていません（人間承認は不要）」と
    // 出ていた（変更のあるツリーで「変更ファイル: 0 件」と報告したうえで）。
    expect(stdout).not.toContain(ASSERTION);
    expect(stdout).toContain('判定はできていません');
    // **何が測れなかったのかを名指しする**（「失敗した」だけでは直せない）。
    expect(stdout).toContain('git diff --name-only');
  }, 60_000);

  it('git が正常なら判定保留にはしない（測れているものまで保留にしない）', () => {
    // 保留へ倒しすぎると「判定保留の常態化」で誰も読まなくなる。過小報告と同じくらい危険。
    const stdout = run();
    expect(stdout).not.toContain('判定はできていません');
    expect(stdout).toContain('変更ファイル:');
  }, 60_000);
});
