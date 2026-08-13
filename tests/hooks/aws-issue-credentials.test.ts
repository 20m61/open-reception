/**
 * `scripts/aws-issue-credentials.sh` の安全性検証 (spec §8)。
 *
 * **秘密の値を出力・保存しないこと**が本スクリプトの唯一かつ最大の要件なので、
 * そこを機械で固定する。AWS へは接続しない（引数検証と本文の性質だけ見る）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * 🔴 **R5（#680 残件）: このファイルにはコメント除去が 1 つも無かった。**
 * `--print` は usage コメント（5 行目）と 2 本の `echo` 文言にも現れ、
 * `OpenReceptionClaudeDeploy-dev` は説明コメント（7 行目）にも現れる。
 * どちらも**実装行を消してもコメントだけで一致する**状態だった。
 * `aws-cloud-deploy.test.ts` と**同じ実装**を共有する（写経すると片方だけ直る）。
 */
import {
  stripBashComments,
  stripBashCommentsAndStrings,
} from '../../src/domain/governance/bash-source';

const SCRIPT = resolve(process.cwd(), 'scripts/aws-issue-credentials.sh');
const source = readFileSync(SCRIPT, 'utf8');
/** コメントのみ除去。**文字列の中身が本体**であるもの（ARN 代入など）を探すのに使う。 */
const code = stripBashComments(source);
/** コメント＋文字列除去。エラー文言・usage に同じ語句があるもの（`--print`）を探すのに使う。 */
const codeNoStrings = stripBashCommentsAndStrings(source);

function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: err.status ?? -1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('値を残さない', () => {
  it('credential をファイルへ書き出さない', () => {
    expect(source).not.toMatch(/>\s*[^&|\s]*credential/i);
    expect(source).not.toContain('~/.aws/credentials');
  });

  it('既定では値を標準出力へ出さない（--print を明示したときだけ）', () => {
    // usage コメントと 2 本のエラー文言にも `--print` があるので、両方落として探す。
    // 残るのは引数パーサの `--print)` ケースだけ。
    expect(codeNoStrings).toContain('--print');
    // echo で SecretAccessKey を直接出す行が無いこと
    expect(source).not.toMatch(/echo\s+.*SecretAccessKey/);
  });

  it('set -x（トレース）を有効にしない', () => {
    expect(source).not.toMatch(/^\s*set\s+-[a-z]*x/m);
  });
});

describe('引数の検証', () => {
  it('--hours に 12 を超える値を拒否する', () => {
    const { status, stderr } = run(['--hours', '13']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('12');
  });

  it('--hours に数値でない値を拒否する', () => {
    expect(run(['--hours', 'abc']).status).not.toBe(0);
  });
});

describe('チェーンを固定する', () => {
  it('専用 entry role を assume する', () => {
    // ARN は文字列リテラルそのものなので、コメントだけを落として探す。
    expect(code).toContain('OpenReceptionClaudeDeploy-dev');
  });

  it('ExternalId を渡す', () => {
    expect(code).toContain('--external-id');
  });
});

describe('VITEST 実行中は AWS を呼ばない（実測で見つかった事故の再発防止）', () => {
  // 🔴 `--hours` の上限チェック（12 を境界とする分岐）を一時的に破壊してテストしたとき
  // （変異テスト）、境界をすり抜けた値がこの安全装置を追加する前は実際に
  // `aws sts assume-role` まで到達し、ローカル Mac に設定済みの実資格情報で
  // AWS STS への本物の API 呼び出しが発生した（`ValidationError` で失敗し資格情報の
  // 発行はされなかったが、意図しない実通信が起きた事実は残る）。
  // `scripts/aws-cloud-deploy.sh` の `collect_observation` と同じ VITEST インターロックを
  // 追加し、それが実際に境界チェックより後・aws 呼び出しより前で機能することを固定する。
  // このプロセス自身が vitest 配下で動いているため `VITEST` は子プロセスへ継承される
  // （上書きしない）。
  //
  // 🔴 **このテストが検査しているのは VITEST インターロックそのものなので、
  // インターロックが機能していることに依存して安全を確保してはいけない。** もし将来
  // 誰かがこのガードを削除したら、このテストは「落ちて事故を検出する」だけでなく、
  // その検出のために**実際に STS 呼び出しを成立させてしまう**危険がある — 実行環境は
  // このスクリプトが対象とするローカル Mac そのもので、`OpenReceptionClaudeDeploy-dev`
  // の信頼ポリシーが唯一許可する principal（`user/CDK`、AdministratorAccess）の資格情報を
  // 持ち得る。実際に Step 5 の変異テストで一度この事故（実 STS 呼び出し）を踏んでいる
  // （`docs` ではなく `.superpowers/sdd/.../task-6-report.md` に実測ログあり）。
  // そこで `tests/hooks/aws-cloud-deploy.test.ts`（「AWS 認証情報が無い」テスト）と同じ
  // 方針で、インターロックが外れても実資格情報に到達できないよう、拾われ得る資格情報源を
  // すべて明らかに偽の値で上書き・無効化する。インターロックが健在ならこれらの上書きは
  // 使われずに終わる（AWS へ到達する前に止まるため）。
  it('妥当な --hours でも VITEST 配下では AWS を呼ばずに止まる', () => {
    const { status, stderr } = run(['--hours', '1'], {
      AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
      AWS_SECRET_ACCESS_KEY: 'fakefakefakefakefakefakefakefakefakefake',
      AWS_SESSION_TOKEN: 'fake-session-token-fake-session-token-fake',
      AWS_PROFILE: 'definitely-not-a-real-profile',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain('VITEST');
  });
});
