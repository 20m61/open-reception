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
   * 🔴 **公開経路の確認はゲートより前**（#1117 AC3）。後ろにあると、壊れていることが
   * 判るのが `--full --strict` を 20〜25 分回した後になる。落ち方は「記録は push 済み・
   * PR は無し」＝ #656 そのもの。
   */
  it('公開経路の事前確認をゲート実行より前に置く', () => {
    const preflight = body.indexOf('scripts/check-publish-path.ts');
    const gate = body.indexOf('quality-gate.sh');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(gate);
  });

  it('事前確認に失敗したらゲートを回さずに落ちる', () => {
    // 「警告を出して続行」にすると、20 分払ってから PR 作成だけが落ちる形へ戻る。
    expect(body).toMatch(/check-publish-path\.ts[\s\S]{0,400}?exit 3/);
  });
});
