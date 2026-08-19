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
 * スタンプ契約に触れる本番ファイル。テストと docs は除く。
 *
 * 🔴 **「呼ぶ」ではなく「名前が出る」で測る。** 呼び出しかどうかを静的に見分けるのは
 * シェルと TS の混在では当てにならない（doc コメントでの言及も拾う）ので、**広く取って
 * docs に載せさせる**。取りこぼすより多めに要求する方がこの目的には合う。
 *
 * 🔴 **読む側だけでなく、指紋を採る側・記録する側も含める**（レビュー Minor-6）。
 * docs の一文は「指紋の採り方を変えるときは全部確かめる」なので、その指紋を**書く**
 * `quality-gate.sh` が一覧に無ければ、この一覧が防ごうとしている当の欠陥
 * （散文が実測から遅れる）を再生産する。
 */
const CONTRACT = /gate_stamp_satisfies|gate_tree_fingerprint|gate_write_stamp/;
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
        return false; // 読めない（symlink 切れ等）
      }
      // NUL を含むならバイナリ。`readFileSync(p,'utf8')` はバイナリでも throw せず
      // U+FFFD へ置換した文字列を返すので、catch では除外できない（レビュー Minor-7）。
      if (text.includes('\0')) return false;
      return CONTRACT.test(text);
    })
    .sort();
}

/**
 * 消費者一覧の節だけを切り出す。
 *
 * 🔴 **文書全体に `toContain` を掛けない**（レビュー Minor-5）。`scripts/quality-gate.sh`
 * は文書中に 5 回出るので、それが将来スタンプを読むようになっても**無言で通る**。
 * 一覧の節に載っていることを見なければ、この束縛は意味を持たない。
 */
function consumerSection(doc: string): string {
  const start = doc.indexOf(SECTION_MARK);
  if (start < 0) throw new Error(`docs/quality-gate.md に消費者一覧の節が見つかりません: ${SECTION_MARK}`);
  const end = doc.indexOf('\n- ', doc.indexOf('\n', start) + 1);
  return doc.slice(start, end < 0 ? doc.length : end);
}

/** 一覧の書き出し（節の特定に使う。変えたらこの定数も変える）。 */
const SECTION_MARK = '- スタンプを読む側は**フックだけではない**。';

describe('ゲートスタンプの消費者 (#711)', () => {
  it('🔴 スタンプ契約に触れるファイルが docs の一覧に全部載っている', () => {
    const doc = consumerSection(readFileSync('docs/quality-gate.md', 'utf8'));
    const consumers = stampConsumers();
    // 空になったら走査条件の方が壊れている（「見つからなかった」を「無い」にしない）。
    expect(consumers.length).toBeGreaterThan(0);
    for (const path of consumers) {
      expect(doc, `docs/quality-gate.md の消費者一覧に ${path} が無い`).toContain(path);
    }
  });
});
