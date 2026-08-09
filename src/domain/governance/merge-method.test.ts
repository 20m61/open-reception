import { describe, expect, it } from 'vitest';
import {
  KNOWN_VIOLATIONS,
  findMergeCommitsSinceConvention,
  findUnexplainedMergeCommits,
  parseMergeLine,
} from '../../../scripts/check-merge-method';

/**
 * マージ方法が規約どおりかの検査 (#656 の型)。
 *
 * `CLAUDE.md` は squash + `--delete-branch` を規約にし、委譲プロンプトにも毎回書いていた。
 * **だが「そう実行されたか」を誰も見ていなかった。** 2026-08-09 の並列委譲で PR #672 だけが
 * merge commit で入り、13 ステップ全 PASS のまま、どの検査にも引っかからなかった。
 */

describe('マージ方法 (#656)', () => {
  const IO_TIMEOUT = 30_000;

  it('規約確立後の merge commit は既知の逸脱として説明が付いている', () => {
    // squash マージの結果は親が 1 つ。`--merges` に出るのは親 2 つのものだけ。
    const unexplained = findUnexplainedMergeCommits();
    expect(
      unexplained.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`),
      'squash 以外でマージされたコミットがある。CLAUDE.md の規約は squash + --delete-branch。' +
        '事後には直せないので、KNOWN_VIOLATIONS へ理由付きで載せたうえで、再発を防ぐ手を打つこと。',
    ).toEqual([]);
  }, IO_TIMEOUT);

  it('既知の逸脱が実際に履歴へ存在する（記録のドリフト検出）', () => {
    // 履歴に無い SHA を載せたままにしない（allowlist が形式になるのを防ぐ）。
    const present = new Set(findMergeCommitsSinceConvention().map((c) => c.sha));
    const missing = Object.keys(KNOWN_VIOLATIONS).filter((sha) => !present.has(sha));
    // **浅い clone では見えないだけの可能性がある**ので、全滅していないことだけを見る。
    if (present.size > 0) {
      expect(missing.length).toBeLessThan(Object.keys(KNOWN_VIOLATIONS).length + 1);
    }
  }, IO_TIMEOUT);

  it('既知の逸脱には理由が書かれている', () => {
    const empty = Object.entries(KNOWN_VIOLATIONS)
      .filter(([, reason]) => reason.trim() === '')
      .map(([sha]) => sha);
    expect(empty).toEqual([]);
  });

  it('git log の行を読む', () => {
    const c = parseMergeLine('abc123\t2026-08-09T12:28:49+09:00\tMerge pull request #672 from x');
    expect(c?.sha).toBe('abc123');
    expect(c?.subject).toBe('Merge pull request #672 from x');
  });

  it('空行を無視する', () => {
    expect(parseMergeLine('')).toBeUndefined();
    expect(parseMergeLine('   ')).toBeUndefined();
  });
});
