import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 後始末する一時ディレクトリ。 */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
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

/**
 * 「測れなかった」実行が**コミットされる記録**へ届くことを固定する (#717)。
 *
 * その場で出る ⚠ は流れて消える。クラウド（`--pr` / `--full` の既定実行環境）は
 * 浅い clone なので、変更範囲を測れない状態が**恒常的に起きていても気づけない**のが
 * この issue の本体。危ないのは判定ではなく**配線**なので、そこを縛る。
 */
describe('record-gate-run.sh: 未測定の印を備考へ残す (#717)', () => {
  /**
   * 🔴 **ソース文字列を grep するテストでは足りない。**
   * 最初 `expect(body).toContain('NOTE  change-scope')` で縛っていたが、
   * **抽出の正規表現を壊す変異（`NOTE  change-scopeZZZ`）が素通り**した
   * （sed 側のリテラルに当たってしまう）。`未測定:` を SKIP 列へ混ぜる変異も通った。
   * 実際に走らせて、**出来上がる行**を見る。
   */
  function runRecord(summary: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'record-gate-run-'));
    created.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/record-gate-run.sh'));
    // ゲートは 25 分かかるのでスタブ。**サマリだけ**出す。
    writeFileSync(
      join(dir, 'scripts/quality-gate.sh'),
      `#!/usr/bin/env bash\ncat <<'EOF'\n${summary}\nEOF\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'docs/gate-runs.md'), '| 日時 | SHA | tier | 結果 | SKIP | 備考 |\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('bash', [join(dir, 'scripts/record-gate-run.sh')], { cwd: dir, encoding: 'utf8' });
    return readFileSync(join(dir, 'docs/gate-runs.md'), 'utf8');
  }

  it('🔴 NOTE 行があれば備考へ「未測定:」として残る', () => {
    const rows = runRecord(
      ['  PASS  typecheck (tsc)  (13s)', '  NOTE  change-scope  (収集に失敗しました)'].join('\n'),
    );
    expect(rows).toContain('未測定:');
    expect(rows).toContain('収集に失敗しました');
  });

  it('🔴 SKIP 列へ混ぜない（既存の記録処理を壊さない）', () => {
    // `gate-run-evaluation.ts` は列を位置で読む。SKIP 列へ混ぜると
    // 「任意ツール未導入」と同じ意味になり、`skipped_steps` が毎週誤発火する。
    const rows = runRecord('  NOTE  change-scope  (収集に失敗しました)');
    const row = rows.trim().split('\n').pop()!;
    const cells = row.split('|').map((c) => c.trim());
    // | 日時 | SHA | tier | 結果 | SKIP | 備考 |
    expect(cells[5], `SKIP 列: ${cells[5]}`).toBe('なし');
    expect(cells[6]).toContain('未測定:');
  });

  it('NOTE 行が無ければ備考は従来どおり（常態化させない）', () => {
    const rows = runRecord('  PASS  typecheck (tsc)  (13s)');
    expect(rows).not.toContain('未測定:');
  });
});
