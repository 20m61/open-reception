/**
 * `scripts/aws-cloud-deploy.sh` の振る舞い検証 (spec §5)。
 *
 * `tests/hooks/guard-destructive.test.ts` と同じ方針: 実際に起動して確かめる。
 * **AWS へは接続しない** — 未知のサブコマンドと引数検証、および
 * 「AWS 認証情報が無いときに黙って成功しない」ことを固定する。
 *
 * 🔴 **VITEST インターロックとの関係。** `scripts/aws-cloud-deploy.sh` の
 * `collect_observation` は `VITEST` 環境変数が非空なら AWS を一切呼ばずに即座に失敗する
 * （Important 7）。このテストプロセス自身が vitest 配下で動いているため、`VITEST=true` は
 * 何もしなければ子プロセスへそのまま継承される。
 *
 * - 「credential 解決の失敗経路そのもの」を確かめたいテスト（下記「AWS 認証情報が無い」）は
 *   意図的に `VITEST: ''` で上書きしてインターロックを迂回し、実際に
 *   `aws sts get-caller-identity` が資格情報解決の時点で失敗する経路を通す
 *   （壊れた profile／空の鍵なので、迂回してもネットワークには出ない）。
 * - 「インターロックそのもの」を確かめたいテスト（下記「VITEST 実行中は」）は
 *   `VITEST` を上書きしない（継承させる）。もっともらしい偽の資格情報を渡しても、
 *   インターロックが `aws` 呼び出しより先に止めることを固定する。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = resolve(process.cwd(), 'scripts/aws-cloud-deploy.sh');

/**
 * 🔴 **`execFileSync` ではなく `spawnSync` を使う。** `execFileSync` は成功時（exit 0）に
 * stdout の文字列だけを返し、stderr は失敗時（例外の `err.stderr`）でしか読めない。
 * `usage()` は exit 0 の `--help` 経路でも stderr にしか usage 行を書かないため、
 * `execFileSync` ベースの旧実装では成功パスの stderr を一切検証できなかった
 * （Important 6 のレビューで指摘されたアサーションの弱さと同根）。`spawnSync` なら
 * 成功・失敗のどちらでも `{ status, stdout, stderr }` を一様に取得できる。
 */
function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  const result = spawnSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('引数の検証', () => {
  it('サブコマンド無しは usage を出して非ゼロ', () => {
    const { status, stderr } = run([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('未知のサブコマンドは非ゼロ', () => {
    const { status, stderr } = run(['destroy']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('destroy');
  });

  // 🔴 旧アサーション `expect(stderr).not.toContain('未知のサブコマンド')` は
  // wrapper が存在しない・bash が構文エラーで落ちる、といった **どんな失敗でも通ってしまう**
  // （「含まない」ことしか見ていないので、無関係な失敗も無条件で PASS になる。
  // 実際、赤の証拠として記録した Step 2 の出力では、この 5 件のパラメタライズドケースは
  // wrapper が存在しない状態でも 6 件の PASS 側に含まれていた＝一度も落ちたことがない
  // アサーションだった）。既知のサブコマンドが `--help` を正しく処理して
  // **usage を出して exit 0 する**ことを直接固定する。
  it.each(['preflight', 'verify', 'diff', 'deploy', 'smoke'])('%s は既知のサブコマンドで --help は usage を出して exit 0', (sub) => {
    const { status, stderr } = run([sub, '--help']);
    expect(status).toBe(0);
    expect(stderr).toContain('Usage');
  });
});

describe('環境の固定', () => {
  it('env=dev 以外を拒否する', () => {
    const { status, stderr } = run(['diff'], { OR_DEPLOY_ENV: 'prod' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('dev');
  });

  it(
    'AWS 認証情報が無い状態で成功と報告しない（credential 解決の失敗経路そのもの）',
    () => {
      // VITEST インターロックを意図的に迂回する（上記ファイル冒頭のコメント参照）。
      // 迂回しても AWS_PROFILE が実在しないため、資格情報解決の時点でローカルに失敗し、
      // ネットワークには出ない。
      //
      // 🔴 item (iii)（2026-08-12 レビュー）: 従来は「AWS_PROFILE が存在しない」という
      // 1 つの機構だけがネットワークとの間に立っていた。profile 解決の実装が将来
      // 変わっても迂回できないよう、資格情報の解決経路そのものを塞ぐ環境変数を
      // 追加する: 設定ファイル／認証情報ファイルを /dev/null に固定し（このマシンの
      // 実ファイルを読ませない）、EC2 メタデータサービス（IMDS）へのフォールバックも
      // 明示的に無効化する。
      const { status, stderr } = run(['preflight'], {
        VITEST: '',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
        AWS_SESSION_TOKEN: '',
        AWS_PROFILE: 'definitely-not-a-real-profile',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain('AWS 認証情報を解決できません');
    },
    // 🔴 実サブプロセス（bash → aws CLI の profile 解決）を起動するため、既定 5000ms は
    // 負荷時に偽の赤を出しうる（CLAUDE.md「調査の作法」既知の罠）。実測は通常 1 秒未満だが、
    // 20 秒の余裕を持たせる。
    20_000,
  );
});

describe('VITEST 実行中は AWS 呼び出しより先に止まる (Important 7)', () => {
  // インターロックが無ければ、この一見もっともらしい（が無効な）資格情報で
  // `aws sts get-caller-identity` が実際にネットワークへ出て AWS と通信を試みる
  // （Step 6 の変異実験で実演済み: dev ガードを外した状態で同種の呼び出しが
  // ホストの資格情報チェーンを辿ろうとして 24 秒近くかかった）。
  // VITEST を上書きしない（継承させる）ことで、インターロックが機能していれば
  // 一瞬で・ネットワークに出ずに失敗することを固定する。
  it(
    'もっともらしい偽の資格情報でもインターロックが先に止める',
    () => {
      const { status, stderr } = run(['preflight'], {
        AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
        AWS_SECRET_ACCESS_KEY: 'fakefakefakefakefakefakefakefakefakefake',
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain('VITEST');
    },
    20_000,
  );
});

describe('workingTreeClean は git status 失敗時に fail-closed する (Important 2)', () => {
  /**
   * `[ -z "$(git -C "${ROOT}" status --porcelain -uall)" ]` という**旧**実装は、
   * `git status` 自体が失敗しても標準出力が空という理由で `clean=true` を返す
   * （「判定できない」が「問題なし」に化ける）。これを再現・固定するには、実際に
   * `git status` を失敗させる必要がある。
   *
   * リポジトリ自身の `.git` を壊すわけにはいかないので、`PATH` へ偽の `git` / `aws` を
   * 差し込む: 偽の `aws` は `sts get-caller-identity` にだけ有効な JSON で応答し
   * （実 AWS を経由せず identity チェックを通過させる）、偽の `git` は
   * `status --porcelain -uall` だけを意図的に失敗させ、それ以外（`rev-parse` 等）は
   * 実 git へ委譲する。これにより「git status だけが失敗した」状況を安全に作れる。
   */
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'aws-cloud-deploy-fake-bin-'));

  writeFileSync(
    join(fakeBinDir, 'aws'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then',
      '  echo \'{"Account":"822063948773","Arn":"arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/test"}\'',
      '  exit 0',
      'fi',
      'echo "fake aws: unsupported args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(fakeBinDir, 'aws'), 0o755);

  writeFileSync(
    join(fakeBinDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = "status" ]; then',
      '    echo "fake git: status failed intentionally" >&2',
      '    exit 128',
      '  fi',
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(fakeBinDir, 'git'), 0o755);

  it(
    'git status が失敗したら workingTreeClean=true に丸め込まず、非ゼロで理由を出す',
    () => {
      const result = spawnSync('bash', [WRAPPER, 'preflight'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VITEST: '',
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        },
      });
      expect(result.status).not.toBe(0);
      // 🔴 これが実際の差別化点: 旧実装（`[ -z "$(git status ...)" ]`）だと git status の
      // 失敗はここでは検出されず、gateStampSatisfied 等の**別の理由**で最終的に失敗する
      // （＝ステータスが非ゼロなだけでは新旧を区別できない）。この特定のメッセージが
      // 出ることそのものが「git status の終了コードを見ている」ことの証拠になる。
      expect(result.stderr ?? '').toContain('git status を実行できませんでした');
    },
    // 旧実装だと最終的に負のシステム（複数の npx tsx 起動）を全部通過するため、この
    // テストは新旧いずれの経路でも複数回のサブプロセス起動を伴う。20 秒の余裕を持たせる。
    20_000,
  );
});

describe('gate_stamp_satisfies の cwd 固定 (Important 3 の回帰テスト、item (i))', () => {
  // 🔴 Important 3（2026-08-12 レビュー第 2 ラウンド）: 前回の対応時、修正だけ入れて
  // 専用の回帰テストを追加しなかったことを自己申告した。「壊れた git を用意せずに
  // テストできるか」を再検討したところ、`tests/hooks/aws-negative-tests-source.test.ts`
  // で使った「ソースを読んで呼び出し箇所の配線を固定する」パターンがそのまま使える
  // （実際に品質ゲートのスタンプを書く必要が無い＝`pr-gate-guard.sh` に影響しない）。
  it('gate_stamp_satisfies "pr" の呼び出しは cd "${ROOT}" のサブシェルでラップされている', () => {
    const source = readFileSync(WRAPPER, 'utf8');
    const marker = 'gate_stamp_satisfies "pr"';
    const idx = source.indexOf(marker);
    // 🔴 マーカーが見つからなければ即座に throw する（無言で PASS にしない）。
    // 呼び出し箇所そのものが将来リネームされた場合に、このテストが「何も検査せずに
    // 通り続ける」ことを防ぐ。
    if (idx === -1) {
      throw new Error(`ソース中に呼び出し箇所が見つかりません: ${marker}`);
    }
    const before = source.slice(Math.max(0, idx - 60), idx);
    expect(before).toMatch(/\(\s*cd "\$\{ROOT\}"\s*&&\s*$/);
  });
});

/**
 * bash の**行コメント**（先頭が `#` の行）を落とす。
 *
 * 🔴 **変異実験で判明した弱さ（2026-08-12 全体レビューの修正時に実測）**: この wrapper は
 * コメントが本文より長い。素の `indexOf('run_diff_gate')` は、`deploy` ケースの直上に
 * 書いた解説コメント（「直前の `run_diff_gate` ループが承認機構であり…」）に一致するため、
 * **実際の呼び出しを削除しても緑のまま**だった。同じ型の欠陥（コメントアウトで
 * すり抜ける）を infra 側の配線テストでも踏んでいる。検索前にコメントを落とす。
 *
 * 行頭 `#` の行だけを対象にする（文字列中の `#` を巻き込まない）。
 */
function stripBashComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('cdk / aws 呼び出しに必須フラグが揃っている (round 3 の回帰テスト)', () => {
  // 🔴 レビュー指摘: ラウンド 2 で入った wrapper の変更（--region 修正・
  // --change-set-name の統一・--toolkit-stack-name 追加）には 1 つもテストが
  // 無かった。`tests/hooks/aws-negative-tests-source.test.ts` と同じ「ソースを読んで
  // マーカーが見つからなければ throw する」パターンで固定する。
  const source = readFileSync(WRAPPER, 'utf8');

  function windowAfter(marker: string, size: number): string {
    const idx = source.indexOf(marker);
    if (idx === -1) throw new Error(`ソース中にマーカーが見つかりません: ${marker}`);
    return source.slice(idx, idx + marker.length + size);
  }

  it('describe-change-set は --region を渡す（Important D の回帰テスト）', () => {
    const block = windowAfter('aws cloudformation describe-change-set', 150);
    expect(block).toContain('--region');
  });

  it('deploy ケースの最終 cdk deploy は --change-set-name を渡す（Important A.1 の回帰テスト）', () => {
    const block = windowAfter('npx cdk deploy "${STACK_NAMES[@]}"', 250);
    expect(block).toContain('--change-set-name');
  });

  /**
   * すべての `npx cdk` 呼び出しの位置。1 つも無ければ throw する（無言で PASS にしない）。
   * 呼び出しは複数行にまたがる（行継続 `\`）ため、次の `npx cdk` か case 区切りまでを窓とする。
   */
  function everyCdkInvocation(): ReadonlyArray<string> {
    const code = stripBashComments(source);
    const occurrences = [...code.matchAll(/npx cdk\b/g)];
    if (occurrences.length === 0) {
      throw new Error('ソース中に "npx cdk" 呼び出しが見つかりません');
    }
    return occurrences.map((m) => code.slice(m.index ?? 0, (m.index ?? 0) + 400));
  }

  it('すべての cdk deploy 呼び出しが --toolkit-stack-name を渡す（項目 4 の回帰テスト）', () => {
    for (const block of everyCdkInvocation()) {
      expect(block).toContain('--toolkit-stack-name');
    }
  });

  // 🔴 Critical 2（2026-08-12 全体レビュー）: `cdk bootstrap --custom-permissions-boundary`
  // は cfn-exec role **1 つ**にしか boundary を付けない
  // （`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml` の
  // `CloudFormationExecutionRole.Properties.PermissionsBoundary`）。CDK アプリが作る Role には
  // 何も付かないので、`claude-cfn-exec.json` の `DenyRoleCreationWithoutBoundary` により
  // 初回 CREATE が AccessDenied になる。**全 `cdk` 呼び出し**が boundary context を
  // 渡していることを固定する（diff 側だけ抜けても deploy 直前まで気づけない）。
  it('すべての cdk 呼び出しが Permissions Boundary の context を渡す (Critical 2)', () => {
    for (const block of everyCdkInvocation()) {
      expect(block).toContain('claudeBoundary=');
    }
  });

  // 🔴 Important 6（2026-08-12 全体レビュー）: CDK CLI の既定は `broadening`
  // （`options.requireApproval ?? RequireApproval.BROADENING`）。TTY の無いサンドボックスでは
  // 権限が広がる差分で `TtyNotAttached` を投げ、しかも投げる**前**に `cleanupChangeSet()` で
  // gate が見た change set を消す。ADR 決定 4 が前提にしている「Lambda 権限変更のたびの
  // IAM Add/Modify」がまさに broadening なので、これは例外ではなく通常運用。
  it('すべての cdk deploy 呼び出しが --require-approval never を渡す (Important 6)', () => {
    for (const block of everyCdkInvocation()) {
      expect(block).toContain('--require-approval never');
    }
  });
});

describe('危険な既定を持たない', () => {
  it('スクリプト本文に --force / --no-verify を含まない', () => {
    const source = readFileSync(WRAPPER, 'utf8');
    expect(source).not.toContain('--force');
    expect(source).not.toContain('--no-verify');
  });

  /**
   * 🔴 **`--require-approval never` を許すからには、承認者が別に居ることを固定する
   * （Important 6）。**
   *
   * 旧テストは `--require-approval never` を**含まないこと**を主張していたが、
   * これは無人実行と矛盾していた（TTY が無いので CDK のプロンプトは必ず落ちる）。
   * 承認機構は `run_diff_gate`（`src/domain/governance/deploy-diff-gate.ts`）であり、
   * CDK の「権限が広がったら聞く」より厳しい。よって `never` は妥当だが、
   * **gate を外したら `never` が丸裸で残る**という失敗の型がある。
   * `deploy` ケースの中で gate が cdk deploy より**前**に走ることを直接固定する。
   */
  it('deploy ケースは cdk deploy の前に diff gate を通す（never を丸裸にしない）', () => {
    const code = stripBashComments(readFileSync(WRAPPER, 'utf8'));
    const caseStart = code.indexOf('\n  deploy)');
    if (caseStart === -1) throw new Error('wrapper に deploy) ケースが見つかりません');
    const caseEnd = code.indexOf('\n  smoke)', caseStart);
    if (caseEnd === -1) throw new Error('wrapper に smoke) ケースが見つかりません（deploy ケースの終端）');
    const block = code.slice(caseStart, caseEnd);

    const gate = block.indexOf('run_diff_gate');
    const deploy = block.indexOf('npx cdk deploy');
    if (gate === -1) throw new Error('deploy ケースが run_diff_gate を呼んでいません');
    if (deploy === -1) throw new Error('deploy ケースに npx cdk deploy がありません');
    expect(gate).toBeLessThan(deploy);
  });

  it('run_diff_gate は判定を aws-diff-gate.ts（純関数の CLI）へ渡している', () => {
    const code = stripBashComments(readFileSync(WRAPPER, 'utf8'));
    const fn = code.indexOf('run_diff_gate() {');
    if (fn === -1) throw new Error('wrapper に run_diff_gate() の定義が見つかりません');
    const end = code.indexOf('\ncase "${SUB}" in', fn);
    if (end === -1) throw new Error('run_diff_gate() の終端が見つかりません');
    expect(code.slice(fn, end)).toContain('scripts/aws-diff-gate.ts');
  });

  it('既定 qualifier hnb659fds を使わない', () => {
    const source = readFileSync(WRAPPER, 'utf8');
    expect(source).toContain('orcloud01');
    expect(source).not.toContain('hnb659fds');
  });
});
