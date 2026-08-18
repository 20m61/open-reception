import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripBashComments, stripBashStringLiterals } from '../../src/domain/governance/bash-source';

/**
 * 週次記録の公開経路が **GraphQL を撃たない**ことを固定する (#678)。
 *
 * ## 何が起きたか
 *
 * 2026-08-10 の `record-gate-run.sh --publish` は、記録の commit と push まで成功したのに
 * `gh pr create` で落ちた。クラウド Routine セッションの `gh` は PR レビュー用の pinned な
 * 操作セットしか GraphQL を通さず、`gh pr create` が本体の POST の前に撃つ repo info
 * preamble（`RepositoryInfo`）が 403 になる。
 *
 * 結果は **push 済み・PR 無し** ―― #656（FAIL が main に載らない）そのものの形である。
 * `gh pr list` / `gh pr view` が 403 になることは PR #665 で既知だったが、
 * **作成側も同じ制約に掛かる**ことはこのとき初めて観測された。
 *
 * ## なぜ「呼んでいないこと」を検査するのか
 *
 * 復帰は 1 行で書ける（`gh pr create` の方が短い）。しかもクラウドでしか落ちないので、
 * **ローカルで書き戻すと誰も気づかない**。コメントや文言に釣られないよう、
 * コメントと文字列リテラルの中身を落としてから本文だけを見る（`bash-source.ts` の由来と同じ理由）。
 */
const SCRIPT = resolve(process.cwd(), 'scripts/record-gate-run.sh');

describe('record-gate-run.sh: PR 作成は REST 経由 (#678)', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  /** コメントを落とした本文。**引用符の中身は残す**（呼び出しの引数はそこに在る）。 */
  const body = stripBashComments(source);
  /**
   * さらに文字列リテラルの中身も落としたもの。dry-run の説明文が
   * `gh pr create は使わない` のように**本物とそっくりな文言**を含むため、
   * 「呼んでいない」を確かめる側はこちらで見る（`bash-source.ts` の由来そのもの）。
   */
  const code = stripBashStringLiterals(body);

  it('gh pr create を呼ばない（クラウド Routine では 403 で必ず落ちる）', () => {
    expect(code).not.toMatch(/gh\s+pr\s+create/);
  });

  it('gh pr list / gh pr view も呼ばない（同じ GraphQL 制約）', () => {
    expect(code).not.toMatch(/gh\s+pr\s+(list|view)/);
  });

  it('REST で PR を作る経路（create-pull-request.ts）へ配線されている', () => {
    // 「呼んでいない」だけでは公開手順が消えたのか REST になったのか区別できない。
    expect(body).toContain('scripts/create-pull-request.ts');
  });

  it('PR まで到達できなければ非ゼロで落ちる（サイレントに終わらせない）', () => {
    // #656 の要点。push だけ済んで終わると、FAIL の記録が main に載らないまま消える。
    expect(body).toMatch(/exit 4/);
  });
});
