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
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * 🔴 **検査前にコメント（と、必要なら文字列リテラル）を落とす。**
 *
 * この wrapper はコメントが本文より長く、日本語のエラーメッセージが本物のコマンドと
 * ほぼ同じ文字列を含む。素の `indexOf` は両方に一致するので、**本物の呼び出しを
 * 削除しても緑のまま**になる。本ブランチはこの型の欠陥を繰り返し踏んでいる。
 *
 * 実装は `src/domain/governance/bash-source.ts`（純関数・co-located テスト付き）。
 * `tests/hooks/aws-issue-credentials.test.ts` も同じものを使う ―― 写経すると
 * 片方だけ直る（#680 R5）。
 */
import {
  stripBashComments,
  stripBashCommentsAndStrings,
} from '../../src/domain/governance/bash-source';

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

describe('依存コマンドの有無を AWS 呼び出し前に検査する (#680)', () => {
  /**
   * `aws` が cloud sandbox に無く、`aws sts get-caller-identity` が
   * `command not found` で失敗した実インシデントの再現。旧実装はこれをそのまま
   * 「AWS 認証情報を解決できません」と報告していた ―― 資格情報は無関係で、
   * 実際にはバイナリが無いだけだった（`docs/runbook-cloud-aws-deploy.md`
   * トラブルシュート「実際に踏んだ」参照）。
   *
   * `aws` を「存在しない」ことにするため、PATH から `aws` 実行ファイルを含む
   * ディレクトリだけを取り除く（`node`/`npx`/`git` は別ディレクトリにあるので
   * 影響しない ―― この開発機で実測済み）。
   */
  function pathWithoutAws(): string {
    const dirs = (process.env.PATH ?? '').split(':');
    const filtered = dirs.filter((dir) => {
      if (dir === '') return true;
      try {
        return !existsSync(join(dir, 'aws'));
      } catch {
        return true;
      }
    });
    return filtered.join(':');
  }

  it(
    'aws が PATH に無ければ、認証情報のせいにせず「aws が見つからない」を報告する',
    () => {
      const pathWithoutAwsValue = pathWithoutAws();
      // 変異検証その 1（欠落方向）: この PATH には実際に aws が無いことを確認してから使う。
      // このガードが無いと、テスト環境の PATH レイアウトが変わったときに
      // 「常に PASS するが何も検査していない」テストへ静かに劣化する。
      const probe = spawnSync('bash', ['-c', 'command -v aws'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathWithoutAwsValue },
      });
      expect(probe.status).not.toBe(0);

      const { status, stderr } = run(['preflight'], {
        VITEST: '',
        PATH: pathWithoutAwsValue,
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain('aws');
      expect(stderr).toContain('cloud-setup.sh');
      // 🔴 これが本 Issue の核心。層を取り違えた旧メッセージを出さないことを固定する。
      expect(stderr).not.toContain('AWS 認証情報を解決できません');
    },
    20_000,
  );

  // 変異検証その 2（存在方向）: 直前の「環境の固定」ブロックにある
  // 「AWS 認証情報が無い状態で成功と報告しない」テストが、この対照そのものを与える ――
  // そちらは実 `aws` バイナリが PATH に存在する前提で、資格情報エラーの文言
  // （「AWS 認証情報を解決できません」）まで到達することを固定している。つまり
  // command-preflight は「aws が有るときは黙って通過し、無いときだけ止める」ことが、
  // 本ブロックのテストと合わせて両方向とも実測されている。
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
    // 窓は行数ではなく文字数。必須 context の行が増えたぶん広げてある（#680 / 2026-08-15）。
    const block = windowAfter('npx cdk deploy "${STACK_NAMES[@]}"', 400);
    expect(block).toContain('--change-set-name');
  });

  /**
   * 🔴 **2026-08-15 のインシデントの回帰テスト。**
   *
   * wrapper が `appSecretsName` / `originVerifySecret` / `publicOriginOverride` を
   * 渡していなかったため、別構成のスタックが synth され、dev の ServerFn から
   * `secretsmanager:GetSecretValue` の付与が消えて **dev が 500** になった。
   * これらは**未指定でも synth が通る**ので、渡し忘れは静かに壊す。
   */
  describe('必須 context が配線されている (#680 / 2026-08-15)', () => {
    it('🔴 すべての cdk deploy 呼び出しが DEPLOY_CONTEXT_ARGS を渡す', () => {
      const invocations = everyCdkInvocation();
      expect(invocations.length).toBeGreaterThan(0);
      for (const inv of invocations) {
        expect(inv, `context を渡していない cdk 呼び出しがある:\n${inv}`).toContain(
          '"${DEPLOY_CONTEXT_ARGS[@]}"',
        );
      }
    });

    it('🔴 diff / deploy は AWS を触る前に context を解決する', () => {
      for (const [label, from, to] of [
        ['diff', '\n  diff)', '\n  deploy)'],
        ['deploy', '\n  deploy)', '\n  smoke)'],
      ] as const) {
        const start = source.indexOf(from);
        const end = source.indexOf(to);
        if (start === -1 || end === -1) throw new Error(`ケース本文が見つかりません: ${label}`);
        const body = source.slice(start, end);
        const ctxAt = body.indexOf('resolve_deploy_context');
        const obsAt = body.indexOf('collect_observation');
        expect(ctxAt, `${label} が resolve_deploy_context を呼んでいない`).toBeGreaterThanOrEqual(0);
        expect(obsAt, `${label} が collect_observation を呼んでいない`).toBeGreaterThanOrEqual(0);
        expect(ctxAt, `${label}: context 解決が観測より後になっている`).toBeLessThan(obsAt);
      }
    });

    it('🔴 解決失敗時に空の配列で先へ進まない（fail-closed）', () => {
      const source = readFileSync(WRAPPER, 'utf8');
      const fn = source.slice(
        source.indexOf('resolve_deploy_context() {'),
        source.indexOf('# 第 3 引数は gate のモード'),
      );
      expect(fn).toContain('return 1');
      // 出力が空だったときも止める（「解決できなかった」を「context 不要」に落とさない）。
      expect(fn).toContain('-eq 0');
    });
  });

  describe('承認トークンのモードが配線されている (#680)', () => {
    /**
     * `run_diff_gate` の呼び出しをすべて拾う。1 つも無ければ throw する
     * （名前を変えたのにテストだけ無言で PASS、を防ぐ）。
     */
    function everyRunDiffGateCall(): ReadonlyArray<string> {
      const calls = [...source.matchAll(/run_diff_gate "\$\{entry%%:\*\}" "\$\{entry##\*:\}"[^\n;]*/g)].map(
        (m) => m[0],
      );
      if (calls.length === 0) throw new Error('run_diff_gate の呼び出しが 1 つも見つかりません');
      return calls;
    }

    it('gate を呼ぶ箇所はすべてモードを明示している（既定任せにしない）', () => {
      for (const call of everyRunDiffGateCall()) {
        expect(call, `モード未指定の呼び出し: ${call}`).toMatch(/\s(diff|deploy)$/);
      }
    });

    it('🔴 diff ケースは diff モード、deploy ケースは deploy モードで呼ぶ', () => {
      const calls = everyRunDiffGateCall();
      expect(calls.filter((c) => c.endsWith(' diff'))).toHaveLength(1);
      expect(calls.filter((c) => c.endsWith(' deploy'))).toHaveLength(1);
    });

    it('gate CLI へモードを引数として渡している', () => {
      // 🔴 ファイル冒頭のコメントにも同じパスが出てくるので、実際の呼び出し行に錨を打つ。
      const block = windowAfter('npx tsx "${ROOT}/scripts/aws-diff-gate.ts"', 250);
      expect(block).toContain('${mode}');
    });

    it('🔴 run_diff_gate のモード既定値は diff（承認を無視する側）', () => {
      const block = windowAfter('run_diff_gate() {', 200);
      expect(block).toContain('mode="${3:-diff}"');
    });
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

/**
 * 🔴 Minor 9 / Important 7（2026-08-12 全体レビュー）。
 *
 * spec §5 の preflight 表にある「branch / commit — 現在の HEAD が push 済みであること」は、
 * 表にあるだけで `DEFAULT_PREFLIGHT_REQUIREMENT` にも `collect_observation` にも
 * 実装が無かった。実装したので、**観測を集める側の配線**を固定する
 * （純関数側の判定は `deploy-preflight.test.ts`、CLI の形式検証は `aws-preflight.test.ts`）。
 */
describe('collect_observation が集める観測 (Minor 9 / Important 7)', () => {
  const code = stripBashComments(readFileSync(WRAPPER, 'utf8'));

  it('headCommitPushed を remote-tracking ref から求めて観測に載せる', () => {
    expect(code).toContain('git -C "${ROOT}" branch -r --contains HEAD');
    expect(code).toContain('"headCommitPushed": ${pushed}');
  });

  /**
   * 🔴 **R5（#680 残件）: このアサーションはコメントを落としていたが、文字列は
   * 落としていなかった。** wrapper には
   * `echo "git branch -r --contains HEAD を実行できませんでした（判定不能）" >&2`
   * というエラー文言があり、`branch -r --contains HEAD` は**本物のコマンドと
   * エラー文言の 2 箇所**に現れる。本物（`git -C "${ROOT}" …`）を削除しても
   * エラー文言だけが残り、その直後には当然 `return 1` があるので、
   * **fail-closed を丸ごと壊しても緑のまま**になりうる。文字列も落として探す。
   */
  const codeNoStrings = stripBashCommentsAndStrings(readFileSync(WRAPPER, 'utf8'));

  it('git branch が失敗したら fail-closed する（判定不能を true に丸めない）', () => {
    const marker = 'branch -r --contains HEAD';
    const occurrences = [...codeNoStrings.matchAll(/branch -r --contains HEAD/g)];
    // 文字列を落とせば残るのは**本物のコマンド 1 箇所だけ**。0 でも 2 以上でも異常。
    expect(occurrences.map(() => marker)).toEqual([marker]);
    const idx = occurrences[0]!.index;
    // 直後のブロックに非ゼロ復帰があること。
    expect(codeNoStrings.slice(idx, idx + 300)).toContain('return 1');
  });

  it('verify が品質ゲート --pr を呼ぶ（preflight が要求するスタンプを書くのはここだけ）', () => {
    const caseStart = code.indexOf('\n  verify)');
    if (caseStart === -1) throw new Error('wrapper に verify) ケースが見つかりません');
    const caseEnd = code.indexOf('\n  diff)', caseStart);
    if (caseEnd === -1) throw new Error('wrapper に diff) ケースが見つかりません（verify ケースの終端）');
    const block = code.slice(caseStart, caseEnd);
    expect(block).toContain('quality-gate.sh');
    expect(block).toContain('--pr');
  });

  /**
   * 🔴 **verify は build:open-next を quality-gate.sh --pr より先に呼ぶ (#680)。**
   *
   * フレッシュな clone には `.open-next/` が無い。旧順序（gate → build）だと、
   * `set -euo pipefail` の下で `quality-gate.sh --pr` が「検査できなかった」ことを
   * 理由に green スタンプを書かず非ゼロで終わり（#640 の設計そのもの）、`set -e` が
   * `verify` をそこで打ち切るため、`.open-next/` を作る唯一の手段である
   * `npm run build:open-next` が一度も実行されない。**何回リトライしても green
   * スタンプが書けないデッドロック**になる（クラウドの実セッションで踏んだ）。
   * ゲートへの入力を作るステップは、ゲートより前に置く。
   */
  it('verify は build:open-next を quality-gate.sh より前に呼ぶ（フレッシュ clone のデッドロック回避）', () => {
    const caseStart = code.indexOf('\n  verify)');
    if (caseStart === -1) throw new Error('wrapper に verify) ケースが見つかりません');
    const caseEnd = code.indexOf('\n  diff)', caseStart);
    if (caseEnd === -1) throw new Error('wrapper に diff) ケースが見つかりません（verify ケースの終端）');
    const block = code.slice(caseStart, caseEnd);
    const buildIdx = block.indexOf('build:open-next');
    const gateIdx = block.indexOf('quality-gate.sh');
    if (buildIdx === -1) throw new Error('verify ケースに build:open-next が見つかりません');
    if (gateIdx === -1) throw new Error('verify ケースに quality-gate.sh が見つかりません');
    expect(buildIdx).toBeLessThan(gateIdx);
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

  /**
   * 🔴 #680 R10。**gate に synth テンプレートを渡していること**を配線として固定する。
   * 渡さなければ CLI は非ゼロで終わるので運用が止まって気づける…と思いたくなるが、
   * 「引数を減らして gate をゆるめる」変更は静かに入りうる。判定側（純関数）が
   * どれだけ厳しくても、入力が来なければ何も検査していないのと同じ
   * （`lesson-green-summary-hides-unwired-step`）。
   */
  it('run_diff_gate は cdk.out の synth テンプレートを gate へ渡している (#680 R10)', () => {
    const code = stripBashComments(readFileSync(WRAPPER, 'utf8'));
    const fn = code.indexOf('run_diff_gate() {');
    const end = code.indexOf('\ncase "${SUB}" in', fn);
    const body = code.slice(fn, end);
    expect(body).toContain('cdk.out/${stack}.template.json');
  });

  /**
   * 🔴 **R5（#680 残件）: `toContain('orcloud01')` は生ソースに対して行っていた。**
   * wrapper には `orcloud01` を説明するコメントが 3 行あるので、`QUALIFIER="orcloud01"`
   * という**実際の設定行を消してもコメントだけで一致し、緑のまま**だった。
   * 肯定側はコメントを落として探す。
   *
   * 否定側（`hnb659fds` を含まない）は**生ソースのまま**にする ―― コメントを落とすと
   * 検査が緩くなる方向であり、「コメントで言及することすら許さない」現状の方が強い。
   */
  it('既定 qualifier hnb659fds を使わない', () => {
    const source = readFileSync(WRAPPER, 'utf8');
    expect(stripBashComments(source)).toContain('orcloud01');
    expect(source).not.toContain('hnb659fds');
  });
});

/**
 * 🔴 **diff は全スタックを評価してから終える。deploy は最初のブロックで即座に止める
 * （非対称、意図的）(#680 続報)。**
 *
 * かつて `diff` も `deploy` と同じ「裸の `for` ループ」で `run_diff_gate` を呼んでいた。
 * `set -euo pipefail` の下では、ループ内で保護されていないコマンドが失敗すると
 * シェル全体が即座に終了する ―― `OpenReception-Web-dev` がブロックされた時点で
 * `OpenReception-CfMon-dev`（us-east-1・初回 CREATE）が一度も評価されなかった
 * のはこれが原因。運用者は「1 つ直して再実行 → 次のブロックで初めて気づく」を
 * スタック数だけ繰り返すはめになる。
 *
 * ここでは 2 通りの検査をする:
 *  1. ソースを読んで、`diff` ケースが `run_diff_gate` を `if !` で包み、`deploy` ケースは
 *     裸のままであることを固定する（構造）。
 *  2. **wrapper から `diff` ケースの実コードそのもの**（コメント無しの生テキストを
 *     `bash -c` へそのまま渡す）を、スタブ `run_diff_gate`（1 番目のスタックだけ
 *     失敗する）と共に実行し、3 スタックとも呼ばれること・非ゼロで終わることを固定する
 *     （振る舞い。実装を書き写したテストではなく、実際のソース片を実行する）。
 */
describe('diff は全スタックを評価してから終える (#680 続報)', () => {
  const code = stripBashComments(readFileSync(WRAPPER, 'utf8'));

  function caseBody(marker: string, endMarker: string): string {
    const start = code.indexOf(marker);
    if (start === -1) throw new Error(`wrapper に ${marker} ケースが見つかりません`);
    const end = code.indexOf(endMarker, start);
    if (end === -1) throw new Error(`wrapper に ${endMarker} ケースが見つかりません（終端探索用）`);
    return code.slice(start, end);
  }

  it('diff ケースは run_diff_gate を if ! で包み、失敗をループの外まで持ち越さない', () => {
    const block = caseBody('\n  diff)', '\n  deploy)');
    expect(block).toContain('if ! run_diff_gate');
    expect(block).toMatch(/diff_failed=1/);
    expect(block).toContain('exit "${diff_failed}"');
  });

  it('deploy ケースは run_diff_gate を裸の for ループで呼ぶ（unwrap しない。fail-closed を弱めない）', () => {
    const block = caseBody('\n  deploy)', '\n  smoke)');
    // "if ! run_diff_gate" ではなく、`for ... ; do run_diff_gate ...; done` のまま。
    expect(block).not.toContain('if ! run_diff_gate');
    // 第 3 引数はモード（#680 の承認トークン）。`deploy` でだけ OR_APPROVED_DIFF が効く。
    expect(block).toContain(
      'for entry in "${STACKS[@]}"; do run_diff_gate "${entry%%:*}" "${entry##*:}" deploy; done',
    );
  });

  /**
   * 🔴 **振る舞いそのものを確かめる。** 上の 2 件は「その文字列がある」ことしか見ておらず、
   * `if !` の中身を書き換えても（例: `diff_failed` を更新しない）緑のままになりうる。
   * ここでは `diff` ケースの本文を実際に `bash -c` で実行し、スタブ `run_diff_gate` を
   * 3 回とも呼び、かつ非ゼロで終わることを固定する。
   */
  it('実際に実行すると、1 番目のスタックが失敗しても 2・3 番目も評価され、最後に非ゼロで終わる', () => {
    const block = caseBody('\n  diff)', '\n  deploy)')
      // ケースラベル行 "  diff)" と実 AWS を呼ぶ collect_observation を取り除き、
      // ループ本体だけを実行する。
      .replace(/^\s*diff\)\s*$/m, '')
      .replace(/^\s*collect_observation.*$/m, '')
      // 実 AWS を触らないので、同じく前段の context 解決も外す（#680 / 2026-08-15）。
      .replace(/^\s*resolve_deploy_context.*$/m, '');
    const script = [
      'set -euo pipefail',
      'STACKS=("OpenReception-Web-dev:ap-northeast-1" "OpenReception-WebMonitoring-dev:ap-northeast-1" "OpenReception-CfMon-dev:us-east-1")',
      'run_diff_gate() {',
      '  echo "called:$1"',
      '  if [ "$1" = "OpenReception-Web-dev" ]; then',
      '    return 1',
      '  fi',
      '  return 0',
      '}',
      block,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const calledStacks = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('called:'));
    expect(calledStacks).toEqual([
      'called:OpenReception-Web-dev',
      'called:OpenReception-WebMonitoring-dev',
      'called:OpenReception-CfMon-dev',
    ]);
    expect(result.status).not.toBe(0);
  });

  /**
   * 対照（deploy 側）: 同じスタブで deploy ケースの本文を実行すると、
   * 1 番目のスタックで即座に止まり、2・3 番目は**呼ばれない**。
   */
  it('対照: deploy ケースの本文は 1 番目のスタックで即座に止まる（2・3 番目は呼ばれない）', () => {
    const block = caseBody('\n  deploy)', '\n  smoke)')
      .replace(/^\s*deploy\)\s*$/m, '')
      .replace(/^\s*collect_observation.*$/m, '')
      // 実 AWS を触らないので、同じく前段の context 解決も外す（#680 / 2026-08-15）。
      .replace(/^\s*resolve_deploy_context.*$/m, '')
      // deploy ケースはこの後 cdk deploy 本体まで続くが、run_diff_gate ループだけを
      // 取り出したいので cs_name の代入以降は使わない。
      .split('cs_name=')[0]!;
    const script = [
      'set -euo pipefail',
      'STACKS=("OpenReception-Web-dev:ap-northeast-1" "OpenReception-WebMonitoring-dev:ap-northeast-1" "OpenReception-CfMon-dev:us-east-1")',
      'run_diff_gate() {',
      '  echo "called:$1"',
      '  if [ "$1" = "OpenReception-Web-dev" ]; then',
      '    return 1',
      '  fi',
      '  return 0',
      '}',
      block,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const calledStacks = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('called:'));
    expect(calledStacks).toEqual(['called:OpenReception-Web-dev']);
    expect(result.status).not.toBe(0);
  });
});
