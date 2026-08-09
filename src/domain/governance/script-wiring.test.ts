import { describe, expect, it } from 'vitest';
import {
  MANUAL_ONLY_ALLOWLIST,
  findStaleAllowlistEntries,
  findUnwiredScripts,
  stripComments,
} from '../../../scripts/check-script-wiring';

/**
 * 「検査が実際に走っているか」のメタ検査 (#656)。
 *
 * 2026-08-08、`scripts/evaluate-gate-runs.ts` を呼ぶものが**リポジトリ内に 1 つも無い**
 * ことが判明した。数日かけて作った `record_gap` / `orphan_branch` の検出器が、
 * **人が手で叩いたときしか走っていなかった**。#656 は「FAIL が誰にも見えないまま消える」
 * issue なので、走らない検出器では閉じない。
 *
 * `docs/ai-development-loop.md` は fitness チェックを 9 件列挙しているが、
 * **その検査自体が走っているかを見るものが無かった**。ここがそれ。
 */

describe('scripts/ の配線 (#656)', () => {
  /**
   * **実ファイルを走査するので既定の 5 秒では負荷に耐えない。**
   * 実際、ゲートの unit ステップ（load 78 / 空きメモリ 1.8G）で
   * `Test timed out in 5000ms` を出して落ちた。走査は 1 パス + メモ化へ直したうえで、
   * 時間制限も実態に合わせる。**アサーションは緩めていない** — ここが見るのは
   * 構造的性質であって速度ではない。
   */
  const IO_TIMEOUT = 30_000;
  it('自動経路から呼ばれないスクリプトは allowlist に理由付きで載っている', () => {
    const unwired = findUnwiredScripts();
    const unexplained = unwired.filter((name) => !(name in MANUAL_ONLY_ALLOWLIST));
    expect(
      unexplained,
      `自動で走る経路（package.json / quality-gate.sh / record-gate-run.sh / hooks / src / infra）から\n` +
        `参照されていないスクリプトがある。配線するか、MANUAL_ONLY_ALLOWLIST へ理由付きで載せること:\n` +
        `  ${unexplained.join(', ')}`,
    ).toEqual([]);
  }, IO_TIMEOUT);

  it('allowlist に「もう自動配線された」ものが残っていない（ドリフト検出）', () => {
    // `check-cjk-literals.ts` の例外リストと同じ型。例外は放置すると意味を失う。
    const stale = findStaleAllowlistEntries();
    expect(stale, `自動配線されたので allowlist から外せる: ${stale.join(', ')}`).toEqual([]);
  }, IO_TIMEOUT);

  it('allowlist の全項目に理由が書かれている', () => {
    // **理由を書けないものは載せない。** 「なんとなく手動」を許すとこの検査は形式になる。
    const empty = Object.entries(MANUAL_ONLY_ALLOWLIST)
      .filter(([, reason]) => reason.trim() === '')
      .map(([name]) => name);
    expect(empty).toEqual([]);
  }, IO_TIMEOUT);

  it('docs / .claude での言及を配線と数えない（言及は実行ではない）', () => {
    // 🔴 **この性質がこの検査の要。** `evaluate-gate-runs.ts` は `docs/` にも
    // `CLAUDE.md` にも書かれていたのに、誰も走らせていなかった。docs を配線と数えると、
    // 塞ごうとしている穴がそのまま素通りする。
    //
    // 実際に「docs にしか出てこないスクリプト」を作って検出されることを確かめたいが、
    // ファイルを作るテストにはしない。代わりに、配線元の集合に docs / .claude が
    // **含まれていない**ことを、検出結果の側から固定する:
    // `record-gate-run.sh` は `docs/quality-gate.md` に詳しく書かれているが、
    // 自動経路からは呼ばれないので未配線として出る（＝ allowlist に載っている）。
    expect(findUnwiredScripts()).toContain('record-gate-run.sh');
    expect(MANUAL_ONLY_ALLOWLIST['record-gate-run.sh']).toBeTruthy();
  }, IO_TIMEOUT);

  describe('stripComments: 言及を配線と数えないための前処理', () => {
    // 🔴 **この関数が無いと検査が狙いを外す。** 呼び出し元を全部消したうえで
    // コメントを数えると、`evaluate-gate-runs.ts` はこのテストファイルのコメントだけで
    // 「配線済み」に見え、#656 の再現を見逃す（実測で確認）。
    it('TS の行コメントを落とす', () => {
      expect(stripComments('a.ts', '// scripts/foo.ts を呼ぶ')).not.toContain('scripts/foo.ts');
    });

    it('TS のブロックコメントを落とす', () => {
      expect(stripComments('a.ts', '/**\n * scripts/foo.ts\n */')).not.toContain('scripts/foo.ts');
    });

    it('シェルのコメント行を落とす', () => {
      expect(stripComments('a.sh', '# scripts/foo.sh を呼ぶ')).not.toContain('scripts/foo.sh');
    });

    it('コードの参照は残す（落としすぎない）', () => {
      expect(stripComments('a.ts', "import x from '../scripts/foo';")).toContain('scripts/foo');
      expect(stripComments('a.sh', './scripts/foo.sh --publish')).toContain('scripts/foo.sh');
    });

    it('json はそのまま返す（コメント構文が無い）', () => {
      expect(stripComments('package.json', '"x": "tsx scripts/foo.ts"')).toContain('scripts/foo.ts');
    });
  });
});
