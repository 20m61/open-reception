import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「検証できなかったステップ」があるとき green として**記録しない**ことを固定する (#640)。
 *
 * ## 何が起きたか
 *
 * `--full` が `infra WebStack synth`（45 件）を SKIP したまま **exit 0** で終わり、
 * `✅ quality-gate PASSED (tier=full を green として記録しました)` と表示していた。
 * この記録は `scripts/hooks/pr-gate-guard.sh` がマージ許可の根拠に使うため、
 * **45 件が走っていない状態でマージが通る**。2026-08-07 の 1 周回で 2 回踏んだ。
 *
 * ## SKIP には 2 種類ある
 *
 * - **任意ツール未導入**（gitleaks/semgrep/lhci が無い）… 従来どおり許容して green。
 *   `docs/quality-gate.md` の既定であり、`--strict` で FAIL にできる。
 * - **前提が壊れていて検査できなかった**（`.open-next` が stale 等）… green の根拠を欠く。
 *   「落ちなかった」だけで「通った」ではないので、**記録を拒否する**。
 *
 * ## なぜ実際に起動するのか
 *
 * 字面を grep するテストはリファクタで簡単に嘘になる（`quality-gate-tiers.test.ts` と
 * 同じ理由）。ここは **exit code と、スタンプファイルが実際に書かれたか**という
 * 副作用で判定する。
 *
 * ## なぜ一時 git リポジトリで動かすのか
 *
 * スタンプは `git rev-parse --absolute-git-dir` 配下に書かれる。本リポジトリで
 * 直接動かすと**このツリーに対する偽の green 記録を残してしまい**、テストが
 * 「マージしてよい」と嘘をつく状態を作る。必ず隔離する。
 */
const REPO = process.cwd();

/** scripts/ だけを持つ一時 git リポジトリを作り、その中で quality-gate.sh を動かす。 */
function runIsolated(
  selftest: string,
  extraEnv: Record<string, string> = {},
): {
  status: number;
  stdout: string;
  stampExists: boolean;
  stamp: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gate-stamp-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(join(dir, 'scripts/quality-gate.sh'), ['--full', '--no-bootstrap'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, QUALITY_GATE_SELFTEST: selftest, ...extraEnv },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? '';
  }

  const stampPath = join(dir, '.git', 'open-reception-gate-stamp');
  const stampExists = existsSync(stampPath);
  return {
    status,
    stdout,
    stampExists,
    stamp: stampExists ? readFileSync(stampPath, 'utf8') : '',
  };
}

describe('quality-gate: 検証できなかったステップは green にしない (#640)', () => {
  it('前提が壊れて検査できなかったとき、green として記録せず非 0 で終わる', () => {
    const r = runIsolated('unverified');

    // 🔴 ここが #640 の本体。**スタンプを書かせない**のが要点で、
    // exit code だけ直しても pr-gate-guard は記録を見るので素通りする。
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it('「検証できなかった」ことが理由付きで出力される（黙って落とさない）', () => {
    const r = runIsolated('unverified');
    // 何が検証できなかったのかが読めること。ラベルが出ないと原因追跡ができない。
    expect(r.stdout).toContain('selftest step');
    // 「PASSED」と誤読させないこと。これが今回の事故そのもの。
    expect(r.stdout).not.toMatch(/✅ quality-gate PASSED/);
  });

  it('任意ツール未導入の SKIP は従来どおり green（既定の契約を壊さない）', () => {
    const r = runIsolated('optional');
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
    expect(r.stamp).toMatch(/^full\t/);
  });

  it('一時領域の状態を毎回出す（残骸とディスクに気づけるように / #721）', () => {
    // 🔴 2026-08-19、`/tmp/cdk.out*` が 740 個・26GB でディスクが 100% になり
    // e2e が `Target crashed` で落ちた。**症状が原因を指さない**ので、毎回測って見せる。
    const r = runIsolated('pass');
    expect(r.stdout).toContain('一時領域');
    expect(r.stdout).toContain('の空き');
    // 🔴 **周回 root も数える。** infra テストの出力は
    // `<tmp>/open-reception-cdk-XXXX/cdk.outYYYY` に落ちるので、`cdk.out*` を深さ 1 で
    // 数えるだけだと**起きうる残骸に対して常に 0** になる（レビュー M1）。
    expect(r.stdout).toContain('周回 root');
    expect(r.stdout).toContain('開始時');
  });

  it('全ステップ PASS なら green として記録する', () => {
    const r = runIsolated('pass');
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
  });
});

/**
 * change-risk が「判定できていません」と言った実行を green として記録しない (#713)。
 *
 * ## なぜ要るか
 *
 * #709 で change-risk は「測れていない」を言えるようになったが、**その状態が機械側へ
 * 伝播していなかった**。`report` で呼ぶだけ・スクリプトも exit 0 だったので、
 * `finish()` は `✅ PASSED` を出し、スタンプに green が載り、`pr-gate-guard.sh` は
 * マージを許した。
 *
 * #705 で委譲プロンプトはこの報告を「**停止境界に触れたかどうかの唯一の根拠**」と
 * 宣言している。その根拠が「測れなかった」と言っているのに機械が素通りするなら、
 * 実効性は「委譲先が節を貼り忘れない」という散文の規律に依存したままになる。
 *
 * #640（`infra WebStack synth` が 45 件 SKIP のまま green 記録）と**まったく同型**なので、
 * 同じ語彙（`skip_unverified`）へ寄せる。**FAILED は立てない**（検出器は report-only の
 * ままにして「赤を無視する習慣」を作らない）。記録だけ拒否する。
 */
describe('quality-gate: change-risk の判定保留を green にしない (#713)', () => {
  it('判定保留（exit 3）なら green として記録せず、非 0 で終わる', () => {
    const r = runIsolated('change-risk:3');
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toMatch(/✅ quality-gate PASSED/);
  });

  it('判定保留の理由が読める（黙って落とさない）', () => {
    const r = runIsolated('change-risk:3');
    expect(r.stdout).toContain('change-risk (停止境界)');
    // 「落ちた」ではなく「測れなかった」と読めること。
    expect(r.stdout).toContain('集めきれ');
  });

  it('検出器そのものが落ちた場合（想定外の exit）も green にしない', () => {
    // クラッシュも「測れなかった」の一種。PASS の根拠にはならない。
    const r = runIsolated('change-risk:1');
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('change-risk (停止境界)');
  });

  it('🔴 実際の呼び出し経路が終了コードを拾っている', () => {
    // 対応表だけをテストしていたときは、**呼び出し側が `|| true` に戻っても
    // 全テストが green のまま**だった（変異で実証）。ここは検出器の中身を差し替えて
    // 「走らせて終了コードを拾って振り分ける」経路そのものを通す。
    const r = runIsolated('change-risk-invoke', { QUALITY_GATE_DETECTOR_CMD: 'exit 3' });
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('change-risk (停止境界)');
  });

  it('tsx が無くて検出器を動かせないときも green にしない', () => {
    // **判定ロジックが unit テスト済みであることは、「このツリーで境界に触れたか」を
    // 測ったことにはならない。** 同じ条件で infra WebStack synth も unverified にしている。
    //
    // 🔴 **「tsx が無い」という前提を、環境任せにしない。** 以前は「一時リポジトリには
    // `node_modules` が無いので `npx --no-install tsx` は失敗する」に頼っていた。ところが
    // `npx --no-install` は **npm の共有キャッシュ（`~/.npm/_npx`）も見る**ので、同じマシンで
    // 一度でも `npx tsx` が走るとキャッシュに載り、**どのディレクトリからでも成功する**。
    // 2026-08-19 に実際そうなり、**コード無変更の main で `--full` が赤くなった**
    // （テストが主張しているのは「tsx が無いとき」なのに、測っていたのは
    // 「たまたま npx が失敗すること」だった）。空のキャッシュを渡して前提をこちらで作る。
    //
    // このテストだけに掛ける —— 全 `runIsolated` に広げると、他のケースまで
    // cache-cold になって別の経路を通る（実際に踏んだ）。
    const npmCache = mkdtempSync(join(tmpdir(), 'gate-stamp-npm-cache-'));
    const r = runIsolated('change-risk-invoke', { npm_config_cache: npmCache });
    expect(r.stampExists).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('tsx が無いため');
  }, 60_000);

  it('実際の呼び出し経路でも、判定できた実行は green として記録する', () => {
    const r = runIsolated('change-risk-invoke', { QUALITY_GATE_DETECTOR_CMD: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
  });

  it('判定できた実行（exit 0）は従来どおり green として記録する', () => {
    // **保留へ倒しすぎない。** 当たりが有っても無くても、測れているなら green を記録する
    // （検出器は report-only であり、判定者ではない）。
    const r = runIsolated('change-risk:0');
    expect(r.status).toBe(0);
    expect(r.stampExists).toBe(true);
  });
});
