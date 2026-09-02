import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.open-next/` が無いときにゲートが**自分でビルドしてから** synth を検査することを固定する (#677)。
 *
 * ## 何が起きたか
 *
 * 2026-08-10 の週次定期ゲート（クラウドの fresh checkout）が FAIL した。退行ではなく
 * **前提の欠落**で、`.open-next/` を 1 度もビルドしていないため `infra WebStack synth` が
 * `skip_unverified` になり、`--strict` 下で green として記録されなかった。
 *
 * fresh checkout はクラウドセッションの**既定の姿**なので、放置すると
 *
 * - 週次ゲートが恒常的に赤くなり「赤を無視する習慣」がつく（#424 増分 3 と同じ理屈）
 * - `--pr` / `--full` が毎回 2 パス（SKIP → 手でビルド → 再実行）になる
 *
 * ## なぜ実際に起動するのか
 *
 * `quality-gate-tiers` / `quality-gate-stamp` と同じ理由。字面を grep するテストは
 * リファクタで簡単に嘘になる。ここは **npm/npx を stub で置き換えて PATH に差し込み、
 * 何が呼ばれたか・記録が書かれたか**という副作用で判定する。
 *
 * ## 壊してはいけない性質
 *
 * ビルドしても fresh にならなかった場合は **#640 の保護（green として記録しない）** が
 * 残ること。「復旧を試みた」ことと「検査できた」ことは別で、後者だけが green の根拠になる。
 */
const REPO = process.cwd();

interface GateRun {
  status: number;
  stdout: string;
  npmCalls: string[];
  stampExists: boolean;
}

/**
 * scripts/ だけを持つ一時 git リポジトリでゲートを動かす。
 *
 * `initialReason` は `.open-next/` の状態を表す probe の出力。空文字が fresh で、
 * 非空はそのまま「検査できなかった理由」になる（`describeArtifactState` の契約）。
 */
function runGate(options: {
  initialReason: string;
  buildFails?: boolean;
  /** ビルドしても fresh にならない状況（ビルドが成功したのに前提が揃わない）。 */
  buildHeals?: boolean;
}): GateRun {
  const dir = mkdtempSync(join(tmpdir(), 'gate-open-next-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'infra'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  const statePath = join(dir, 'artifact-reason');
  const npmLog = join(dir, 'npm-calls');
  writeFileSync(statePath, options.initialReason);
  writeFileSync(npmLog, '');

  // `npx --no-install tsx ...` の 3 用途を撃ち分ける stub。
  //   --version         … tsx の有無の判定
  //   -e <script>       … .open-next/ の状態 probe（本物は describeArtifactState を出す）
  //   *.ts              … change-budget / change-scope
  writeFileSync(
    join(dir, 'bin', 'npx'),
    `#!/usr/bin/env bash
case "$*" in
  *--version*) exit 0 ;;
  *" -e "*) cat "${statePath}"; exit 0 ;;
  *change-scope.ts*) echo "scope=code"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );

  // 呼ばれた npm を全部記録する。build:open-next のときだけ状態を書き換える
  // （＝ビルドが成功すれば probe が fresh を返すようになる、という現実の因果を模す）。
  writeFileSync(
    join(dir, 'bin', 'npm'),
    `#!/usr/bin/env bash
echo "$*" >> "${npmLog}"
case "$*" in
  *build:open-next*)
    ${options.buildFails === true ? 'exit 1' : ''}
    ${options.buildHeals === false ? '' : `printf '' > "${statePath}"`}
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      join(dir, 'scripts/quality-gate.sh'),
      ['--infra', '--no-bootstrap', '--no-skip-docs'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
      },
    );
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? '';
  }

  return {
    status,
    stdout,
    npmCalls: readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean),
    stampExists: existsSync(join(dir, '.git', 'open-reception-gate-stamp')),
  };
}

const ABSENT = '.open-next/ が未ビルド（不足: open-next.output.json）— `npm run build:open-next` で作成';

describe('quality-gate: .open-next/ が無ければ自分でビルドする (#677)', () => {
  /**
   * 実際にゲートを起動するので、**既定の 5s では負荷時に足りない**。
   * 単体では 2s 前後だが `npm test` の同時実行下では 5〜7s まで伸び、
   * アサーションに到達する前に落ちる（このリポジトリが繰り返し踏んでいる偽の赤）。
   */
  const IO_TIMEOUT = 30_000;

  it('未ビルドなら build:open-next を実行し、synth を未検査のまま終わらせない', () => {
    const run = runGate({ initialReason: ABSENT });

    // 🔴 これが #677 の本体。fresh checkout（＝クラウドセッションの既定の姿）で
    // 「SKIP → 人が手でビルド → 再実行」の 2 パスを強いていた。
    expect(run.npmCalls.some((c) => c.includes('build:open-next'))).toBe(true);
    expect(run.stdout).not.toContain('SKIP  infra WebStack synth');
    expect(run.status).toBe(0);
    // 検査できたので green として記録してよい。
    expect(run.stampExists).toBe(true);
  }, IO_TIMEOUT);

  it('fresh なら build:open-next を実行しない（毎回のゲートに無駄なビルドを足さない）', () => {
    const run = runGate({ initialReason: '' });

    expect(run.npmCalls.some((c) => c.includes('build:open-next'))).toBe(false);
    expect(run.status).toBe(0);
  }, IO_TIMEOUT);

  it('ビルドが失敗したら FAIL にする（黙って SKIP へ倒さない）', () => {
    // ビルドが通らないツリーは synth もデプロイもできない。「検査を省いた」ではなく
    // 「壊れている」ので、赤にするのが正しい。
    const run = runGate({ initialReason: ABSENT, buildFails: true });

    expect(run.stdout).toContain('FAIL  build (open-next)');
    expect(run.status).toBe(1);
    expect(run.stampExists).toBe(false);
  }, IO_TIMEOUT);

  it('ビルドしても fresh にならなければ green として記録しない（#640 の保護を壊さない）', () => {
    // 「復旧を試みた」ことは「検査できた」ことではない。ここを緩めると、45 件の synth が
    // 走っていないまま pr-gate-guard がマージを許した #640 が戻る。
    const run = runGate({ initialReason: ABSENT, buildHeals: false });

    expect(run.stdout).toContain('SKIP  infra WebStack synth');
    expect(run.stampExists).toBe(false);
    expect(run.status).toBe(1);
  }, IO_TIMEOUT);
});
