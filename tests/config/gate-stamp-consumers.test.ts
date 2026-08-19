/**
 * ゲートスタンプを読む側の一覧が、docs の散文と食い違わないようにする (#711 レビュー Minor 4)。
 *
 * ## なぜ機械で縛るか
 *
 * `docs/quality-gate.md` は「指紋の採り方を変えるときは消費者を全部確かめる」と書いている
 * が、その一覧は散文なので**新しい消費者が増えても誰も落ちない**。#720（指紋の採り方を
 * 変えた周回）でこの一覧が既に不完全だったことをレビューが 2 度指摘している。
 * この repo が繰り返し踏んでいる「散文が実測から遅れる」型なので、実測を正本にする。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * スタンプ契約（`gate_stamp_satisfies`）に触れる本番ファイル。テストと docs は除く。
 *
 * 🔴 **「呼ぶ」ではなく「名前が出る」で測る。** 呼び出しかどうかを静的に見分けるのは
 * シェルと TS の混在では当てにならない（doc コメントでの言及も拾う）ので、**広く取って
 * docs に載せさせる**。取りこぼすより多めに要求する方がこの目的には合う。
 */
function stampConsumers(): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
  return tracked
    .filter((p) => p !== '')
    .filter((p) => !p.startsWith('docs/') && !p.startsWith('tests/') && !p.includes('.test.'))
    // ライブラリ自身（定義元）は消費者ではない。
    .filter((p) => p !== 'scripts/lib/gate-stamp.sh')
    .filter((p) => {
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        return false; // バイナリ等
      }
      return text.includes('gate_stamp_satisfies');
    })
    .sort();
}

describe('ゲートスタンプの消費者 (#711)', () => {
  it('🔴 `gate_stamp_satisfies` に触れるファイルが docs に全部載っている', () => {
    const doc = readFileSync('docs/quality-gate.md', 'utf8');
    const consumers = stampConsumers();
    // 空になったら走査条件の方が壊れている（「見つからなかった」を「無い」にしない）。
    expect(consumers.length).toBeGreaterThan(0);
    for (const path of consumers) {
      expect(doc, `docs/quality-gate.md がスタンプ契約に触れる ${path} を挙げていない`).toContain(path);
    }
  });
});
