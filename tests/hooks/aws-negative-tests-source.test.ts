/**
 * `scripts/aws-negative-tests.ts` の判定関数の配線を固定する (Critical 1 の回帰テスト)。
 *
 * このスクリプト自体は AWS 認証情報が無いと実行できないため（本サイクルでは一度も
 * 実走しない）、判定ロジックは `src/domain/governance/negative-test-outcome.ts` の
 * 純関数へ切り出し、そちらをテストしている。
 *
 * しかし **「どちらの判定関数をどちらの catch で呼ぶか」という配線そのもの**が誤ると
 * 意味が反転する: `aws()`（対象アクションを直接実試行）の catch は `classifyAwsError`
 * を使ってよいが、`simulate()`（`iam:SimulatePrincipalPolicy` という別の API を呼ぶ）の
 * catch で `classifyAwsError` を使うと、`SimulatePrincipalPolicy` 自体への AccessDenied が
 * 「評価対象アクションが denied だった（＝PASS）」に化ける（2026-08-12 レビューで発見）。
 * 純関数のテストだけではこの配線ミスを検出できないため、
 * `tests/hooks/aws-cloud-deploy.test.ts` と同じ「ソースを読んで固定する」方針で covering する。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/aws-negative-tests.ts');
const SOURCE = readFileSync(SCRIPT, 'utf8');

/**
 * CLI を実際に起動する。
 *
 * 🔴 **`VITEST` は上書きしない（継承させる）。** `scripts/aws-negative-tests.ts` の
 * `refuseUnderTestRuntime` は `VITEST` が非空なら `aws` を呼ぶ手前で exit 3 する。
 * ここで検証したいのは「AWS へ出る前の引数・環境変数の検証」だけなので、
 * インターロックを迂回する理由が無い。**周囲に本物の資格情報が残っていても
 * ネットワークに出ないことを、テスト側の期待値ではなく実装側の分岐で保証する。**
 */
function run(args: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) {
  // `undefined` を渡すと子プロセスに文字列 "undefined" が入る環境があるため、
  // キーごと落とす（「未設定」と「空文字」を取り違えないため）。
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete merged[k];
  }
  const r = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: merged as NodeJS.ProcessEnv,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const FAKE_ARNS = {
  SIMULATE_ENTRY_ROLE_ARN: 'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev',
  SIMULATE_DEPLOY_ROLE_ARN: 'arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1',
  SIMULATE_EXEC_ROLE_ARN: 'arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1',
};

function extractFunctionBody(source: string, functionSignature: string, nextMarker: string): string {
  const start = source.indexOf(functionSignature);
  if (start === -1) throw new Error(`function not found in source: ${functionSignature}`);
  const end = source.indexOf(nextMarker, start);
  if (end === -1) throw new Error(`next marker not found after ${functionSignature}: ${nextMarker}`);
  return source.slice(start, end);
}

describe('aws() と simulate() の catch が正しい判定関数を呼んでいる', () => {
  it('aws()（対象アクションを直接実試行）の catch は classifyAwsError を使う', () => {
    const body = extractFunctionBody(SOURCE, 'function aws(', 'const assumeRole');
    expect(body).toContain('classifyAwsError(stderr)');
  });

  it('simulate()（SimulatePrincipalPolicy という別の API）の catch は classifyAwsError を使わない', () => {
    const body = extractFunctionBody(SOURCE, 'function simulate(', 'function main(');
    expect(body).not.toContain('classifyAwsError(stderr)');
  });

  it('simulate() の catch は classifySimulationError を使う', () => {
    const body = extractFunctionBody(SOURCE, 'function simulate(', 'function main(');
    expect(body).toContain('classifySimulationError(stderr)');
  });
});

/**
 * 🔴 **Critical 3（2026-08-12 全体レビュー）: S 系は「落ちようのない検査」だった。**
 *
 * 旧実装は principal ARN を 1 本だけ受け取り、既定を entry role にしていた。
 * entry role は 4 アクション以外を最初から全 Deny するので、S1〜S11 は
 * `claude-boundary.json` / `claude-cfn-exec.json` の有無に関係なく全部 `denied` を返す。
 *
 * ここでは **CLI を実際に起動して**、principal が供給されていなければ
 * **走らずに落ちる**ことを固定する（文書ではなく構造で footgun を潰す）。
 */
describe('S 系は principal ARN が供給されないと実行を拒否する (Critical 3)', () => {
  it(
    'principal ARN が 1 つも無ければ非ゼロで終わり、どの環境変数が要るかを列挙する',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        SIMULATE_ENTRY_ROLE_ARN: undefined,
        SIMULATE_DEPLOY_ROLE_ARN: undefined,
        SIMULATE_EXEC_ROLE_ARN: undefined,
        SIMULATE_PRINCIPAL_ARN: undefined,
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_ENTRY_ROLE_ARN');
      expect(stderr).toContain('SIMULATE_DEPLOY_ROLE_ARN');
      expect(stderr).toContain('SIMULATE_EXEC_ROLE_ARN');
    },
    60_000,
  );

  it(
    '一部だけ供給されていても走らない（exec だけ欠けている場合）',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        SIMULATE_EXEC_ROLE_ARN: undefined,
        SIMULATE_PRINCIPAL_ARN: undefined,
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_EXEC_ROLE_ARN');
      expect(stderr).not.toContain('SIMULATE_DEPLOY_ROLE_ARN');
    },
    60_000,
  );

  // 空文字は「供給された」ではない（[[空文字は「問題なし」ではない]]）。
  it(
    '空文字の ARN は未供給として扱う（未展開の環境変数を素通りさせない）',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        SIMULATE_EXEC_ROLE_ARN: '',
        SIMULATE_PRINCIPAL_ARN: undefined,
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_EXEC_ROLE_ARN');
    },
    60_000,
  );

  it(
    '廃止された SIMULATE_PRINCIPAL_ARN が設定されていたら明示的に止める',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        SIMULATE_PRINCIPAL_ARN: 'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev',
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_PRINCIPAL_ARN は廃止されました');
    },
    60_000,
  );

  it(
    'principal が揃っていれば検証を通過し、AWS 呼び出しの直前でインターロックが止める',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        SIMULATE_PRINCIPAL_ARN: undefined,
      });
      // exit 3 = インターロック専用（2 = 引数エラー / 1 = 検査 FAIL と区別する）。
      // ここが 2 のままなら、principal 検証が「揃っている」を認識できていない。
      expect(status).toBe(3);
      expect(stderr).toContain('VITEST 実行中のため AWS を呼びません');
    },
    60_000,
  );
});

describe('SIMULATED_CHECKS は全件が principal を宣言している (Critical 3)', () => {
  const block = extractFunctionBody(SOURCE, 'const SIMULATED_CHECKS', 'const PRINCIPAL_ENV_VARS');

  it('各 check が principals を持つ（id の数と principals の数が一致する）', () => {
    const ids = [...block.matchAll(/^\s*id: '(S\d+)',/gm)].map((m) => m[1]);
    const principals = [...block.matchAll(/^\s*principals: \[/gm)];
    // 🔴 0 件なら空虚に真になる。抽出できていることを先に固定する。
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(principals.length).toBe(ids.length);
  });

  it('boundary 脱出系（S4/S5/S7）は exec に対して評価される', () => {
    for (const id of ['S4', 'S5', 'S7']) {
      const start = block.indexOf(`id: '${id}',`);
      if (start === -1) throw new Error(`SIMULATED_CHECKS に ${id} が見つかりません`);
      const entry = block.slice(start, block.indexOf('},', start));
      expect(entry).toContain("'exec'");
    }
  });

  it('既定の principal ARN をソース中に持たない（1 本で全部を評価する形へ戻さない）', () => {
    expect(SOURCE).not.toContain('process.env.SIMULATE_PRINCIPAL_ARN ??');
  });
});
