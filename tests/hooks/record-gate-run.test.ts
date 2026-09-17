import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 後始末する一時ディレクトリ。 */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
import { stripBashComments, stripBashStringLiterals } from '../../src/domain/governance/bash-source';
import { makeTempDir } from '../helpers/temp';

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
    const dir = makeTempDir('record-gate-run-');
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

/**
 * 公開経路の確認が **どこで報告し、どこで止めるか**を挙動で縛る (#1117 AC3)。
 *
 * ## 設計（独立レビュー 2 周目で作り直した）
 *
 * | 呼ばれる場所 | 役割 |
 * | --- | --- |
 * | ゲートの**前** | 報告だけ。**絶対に止めない** |
 * | `git push` の**直前** | 到達できなければ **push せずに**終える |
 *
 * 🔴 **ゲートの前で止める設計は撤回した。** 記録の追記も `evaluate:gate-runs` も
 * `loop:retro` も publish の後ろに居るので、止めると FAIL の測定そのものが消える。
 * しかも fresh clone（クラウド週次 routine の既定の姿）では `npx --no-install tsx` 自体が
 * 失敗するので、「毎週 1 秒も走らない」に倒れうる。
 *
 * 🔴 **代わりに push の直前で止める。** #656 の被害は「push されたブランチに PR が
 * 無いまま残ること」なので、そこを作らせなければよい。ゲートも記録も既に済んでいる。
 */
describe('record-gate-run.sh: 報告はゲート前、判断は push の直前 (#1117)', () => {
  /** 子プロセスで bash とスクリプトを起動するので、既定の 5 秒では負荷下で足りない。 */
  const SPAWN_TIMEOUT_MS = 30_000;

  type PublishRun = { code: number; gateRan: boolean; pushed: boolean; stderr: string };

  /**
   * 到達性検査の結果を差し替えた砂場で `--publish` を回す。
   *
   * 検査は `npx --no-install tsx .../check-publish-path.ts` として呼ばれるので、
   * PATH の `npx` を差し替えれば結果を決められる。`git` も差し替えて
   * **push が試みられたかどうか**を観測する（#656 の被害はそこにしか出ない）。
   */
  function runPublish(checkExitCode: number): PublishRun {
    const dir = makeTempDir('record-gate-publish-');
    created.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    cpSync(SCRIPT, join(dir, 'scripts/record-gate-run.sh'));
    writeFileSync(join(dir, 'docs/gate-runs.md'), '| 日時 | SHA | tier | 結果 | SKIP | 備考 |\n');

    const marker = join(dir, 'gate-ran');
    writeFileSync(join(dir, 'scripts/quality-gate.sh'), `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
    chmodSync(join(dir, 'scripts/quality-gate.sh'), 0o755);
    writeFileSync(
      join(dir, 'bin/npx'),
      `#!/usr/bin/env bash\ncase "$*" in *check-publish-path*) exit ${checkExitCode};; esac\nexit 0\n`,
    );
    chmodSync(join(dir, 'bin/npx'), 0o755);
    writeFileSync(join(dir, 'bin/npm'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(dir, 'bin/npm'), 0o755);
    // `git` は成功させつつ、何を呼ばれたかを記録する。
    writeFileSync(
      join(dir, 'bin/git'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/git.log"\nexit 0\n`,
    );
    chmodSync(join(dir, 'bin/git'), 0o755);

    const result = spawnSync('bash', [join(dir, 'scripts/record-gate-run.sh'), '--publish'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
    });
    let gitLog = '';
    try {
      gitLog = readFileSync(join(dir, 'git.log'), 'utf8');
    } catch {
      gitLog = '';
    }
    return {
      code: result.status ?? 1,
      gateRan: existsSync(marker),
      pushed: /(^|\n)push /.test(gitLog),
      stderr: result.stderr ?? '',
    };
  }

  /**
   * 🔴 **ゲートは何があっても回る。** ここが 1 周目の BLOCKER の再発防止線である。
   * `1` は fresh clone で `npx --no-install tsx` が返す値（node_modules 未導入）。
   */
  it.each([0, 1, 3, 127])(
    '到達性検査が exit %i でもゲートは回る（ゲート前では止めない）',
    (code) => {
      expect(runPublish(code).gateRan).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * 🔴 **到達できないなら push しない。** push してしまうと、PR の無いブランチが
   * リモートに残る ―― #656 の被害そのもの。
   */
  it(
    '到達できなければ push しない（PR の無いブランチを残さない）',
    () => {
      const run = runPublish(3);
      expect(run.pushed).toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.gateRan).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  /** 下界。「常に push しない」では publish が成立しない。到達できれば push する。 */
  it(
    '到達できれば push する',
    () => {
      expect(runPublish(0).pushed).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
