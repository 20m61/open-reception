/**
 * 公開経路（PR 作成・マージ・取りこぼし検査）が **GitHub CLI に依存しない**ことを固定する (#1117)。
 *
 * ## 事実
 *
 * 2026-09-15、Claude Code on the web のサンドボックスに **`gh` が無い**ことが判明した
 * （`command -v gh` が空）。`scripts/create-pull-request.ts` は `gh api` を直接呼んでいた
 * ため PR を作れず、PR #1115 / #1116 はどちらも落ちて GitHub MCP へ手で切り替えた。
 * `scripts/record-gate-run.sh --publish` は同じスクリプトへ委ねているので、週次ゲートを
 * 仕掛ければ **記録は push 済み・PR は無し** ―― #656 そのもの ―― が再生産される。
 *
 * ## なぜ「呼んでいないこと」を検査するのか
 *
 * 復帰は 1 行で書ける（`run('gh', [...])` の方が短い）。しかも**その環境でしか落ちない**
 * ので、`gh` が在る環境で書き戻すと誰も気づかない。`record-gate-run.sh` が
 * `gh pr create` を呼ばないことを #678 で同じ理由から固定したのと同型である。
 *
 * 🔴 **「呼んでいない」だけでは足りない。** 公開手順が消えたのか REST になったのかを
 * 区別できないので、**共有の REST 経路へ配線されていること**（下界）も併せて縛る。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../scripts/check-script-wiring';
import { stripBashComments, stripBashStringLiterals } from '../../src/domain/governance/bash-source';

/** 公開経路を構成する TypeScript。**どれか 1 本でも `gh` に戻ると経路全体が落ちる。** */
const TS_FILES = [
  'scripts/create-pull-request.ts',
  'scripts/merge-pull-request.ts',
  'scripts/evaluate-gate-runs.ts',
  'scripts/check-publish-path.ts',
  'scripts/lib/github-api.ts',
] as const;

function code(rel: string): string {
  const abs = resolve(process.cwd(), rel);
  return stripComments(abs, readFileSync(abs, 'utf8'));
}

/**
 * `execFileSync('gh', ...)` の形。**文字列リテラルとしての `gh` だけ**を見る。
 * `github-rest` や `callGitHubJson` のような語に当たらないよう、引用符で挟まれた
 * ちょうど `gh` に限定する。
 */
const GH_COMMAND_LITERAL = /['"]gh['"]/;

describe('公開経路は GitHub CLI に依存しない (#1117)', () => {
  it.each(TS_FILES)('%s は gh を実行しない', (rel) => {
    expect(code(rel)).not.toMatch(GH_COMMAND_LITERAL);
  });

  /**
   * 下界。`gh` を消しただけで REST を叩かなくなっていたら、PR は作られないまま
   * 「gh を呼んでいない」だけが緑になる。
   */
  it.each(TS_FILES.filter((f) => f !== 'scripts/lib/github-api.ts'))(
    '%s は共有の REST 経路（lib/github-api）へ配線されている',
    (rel) => {
      expect(code(rel)).toContain('lib/github-api');
    },
  );

  it('共有の REST 経路は curl で叩く（proxy と CA を環境から解決できる唯一の経路）', () => {
    expect(code('scripts/lib/github-api.ts')).toContain("'curl'");
  });

  /**
   * 🔴 **#656 の作法（申告を信じず引き直す）が transport の載せ替えで落ちていないこと。**
   * 「gh を呼んでいない」だけを縛ると、引き直しごと消えても緑のままになる。
   */
  it('PR 作成は作成後にブランチを head に持つ PR を引き直す', () => {
    expect(code('scripts/create-pull-request.ts')).toContain('pullsQueryRequest');
  });

  it('マージはマージ後に PR の状態を引き直す', () => {
    expect(code('scripts/merge-pull-request.ts')).toContain('pullReadRequest');
  });
});

describe('record-gate-run.sh は GitHub CLI に依存しない (#678 / #1117)', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/record-gate-run.sh'), 'utf8');
  /**
   * コメントも文字列リテラルの中身も落としてから見る。dry-run の説明文が
   * 本物とそっくりな文言を含むため（`bash-source.ts` の由来そのもの）。
   */
  const body = stripBashComments(source);
  const stripped = stripBashStringLiterals(body);

  it('gh を実行しない', () => {
    expect(stripped).not.toMatch(/(^|[;&|\s])gh(\s|$)/);
  });

  /**
   * 🔴 **到達性の確認は 2 箇所から呼ばれる**（#1117。独立レビュー 2 周目で作り直した）:
   * ゲートの**前**（報告だけ）と `git push` の**直前**（止める）。
   *
   * ここはソースの構造だけを見る。**どちらが止めるか**という意味のある主張は
   * `tests/hooks/record-gate-run.test.ts` が実起動で持っている ―― かつてここに在った
   * 「事前確認に失敗したらゲートを回さずに落ちる」は、実装を作り直した後も
   * **文字列一致のまま緑で残っていた**（規約「仕様を足したら既存の回帰テストが
   * 空虚に通るようになっていないか測る」の型）。意味を持てない主張は置かない。
   */
  it('到達性の確認をゲートの前と push の直前の 2 箇所から呼ぶ', () => {
    const calls = body.split('scripts/check-publish-path.ts').length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('ゲートより前に 1 度目を置く', () => {
    const first = body.indexOf('scripts/check-publish-path.ts');
    const gate = body.indexOf('quality-gate.sh');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(gate);
  });

  it('push より前に 2 度目を置く', () => {
    const push = body.indexOf('git push');
    const lastCheck = body.lastIndexOf('scripts/check-publish-path.ts');
    expect(push).toBeGreaterThanOrEqual(0);
    expect(lastCheck).toBeLessThan(push);
  });
});
