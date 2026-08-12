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

const ROLE = (name: string) => `arn:aws:iam::822063948773:role/${name}`;

/** #680 R4: deploy / exec は region ごとに別のロールなので、鍵も環境変数も region ごと。 */
const FAKE_ARNS: Record<string, string | undefined> = {
  SIMULATE_ENTRY_ROLE_ARN: ROLE('OpenReceptionClaudeDeploy-dev'),
  SIMULATE_DEPLOY_ROLE_ARN_AP_NORTHEAST_1: ROLE('cdk-orcloud01-deploy-role-822063948773-ap-northeast-1'),
  SIMULATE_DEPLOY_ROLE_ARN_US_EAST_1: ROLE('cdk-orcloud01-deploy-role-822063948773-us-east-1'),
  SIMULATE_EXEC_ROLE_ARN_AP_NORTHEAST_1: ROLE('cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1'),
  SIMULATE_EXEC_ROLE_ARN_US_EAST_1: ROLE('cdk-orcloud01-cfn-exec-role-822063948773-us-east-1'),
};

/** 廃止された変数。テストの env に混ざると `exit 2` になるので明示的に落とす。 */
const NO_RETIRED_ARNS = {
  SIMULATE_PRINCIPAL_ARN: undefined,
  SIMULATE_DEPLOY_ROLE_ARN: undefined,
  SIMULATE_EXEC_ROLE_ARN: undefined,
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
 * TypeScript のコメントを落とす。
 *
 * 🔴 **R5 の教訓（#680）**: このファイルのアサーションは生ソースに対して行っていた。
 * `--context-entries` はコメントにも 2 箇所現れるので、**実装行を消してもコメントだけで
 * 一致し、緑のまま**になる。探す前にコメントを落とす。
 */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * 🔴 **#680 R10 / D: carve-out は 2 枚のポリシーで成立している。**
 *
 * `claude-cfn-exec.json` の Allow だけを評価しても、`claude-boundary.json` 側の
 * `NotResource` が壊れていれば**初回デプロイは Deny で落ちる**。
 * `SimulatePrincipalPolicy` がアタッチ済み boundary を自動で含めるかどうかは
 * AWS を呼ばずには確かめられないので、明示的に渡していることを構造で固定する。
 */
describe('simulate() は boundary と context を明示的に渡す (#680 R10 / D)', () => {
  const body = stripTsComments(extractFunctionBody(SOURCE, 'function simulate(', 'function main('));

  it('boundary ポリシー文書を --permissions-boundary-policy-input-list で渡す', () => {
    expect(body).toContain('--permissions-boundary-policy-input-list');
    expect(body).toContain('BOUNDARY_POLICY_PATH');
  });

  it('リクエスト側 context key を --context-entries で渡す', () => {
    expect(body).toContain('--context-entries');
  });

  /**
   * boundary が付くのは cfn-exec role **だけ**（`--custom-permissions-boundary` の仕様。
   * runbook ステップ 2）。entry / deploy にも渡すと、実際には通る呼び出しが denied に
   * 見えて偽の PASS になる。
   */
  it('boundary を渡すのは exec だけ', () => {
    const decl = extractFunctionBody(
      stripTsComments(SOURCE),
      'const BOUNDARY_BEARING_PRINCIPALS',
      'function assertBoundaryPolicyReadable',
    );
    expect(decl).toContain("'exec'");
    expect(decl).not.toContain("'entry'");
    expect(decl).not.toContain("'deploy'");
  });

  it('boundary ファイルが読めなければ実行しない（読まずに「検証済み」と記録させない）', () => {
    expect(stripTsComments(SOURCE)).toContain('assertBoundaryPolicyReadable()');
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
      const cleared = Object.fromEntries(Object.keys(FAKE_ARNS).map((k) => [k, undefined]));
      const { status, stderr } = run(['--simulate-only'], { ...cleared, ...NO_RETIRED_ARNS });
      expect(status).toBe(2);
      for (const name of Object.keys(FAKE_ARNS)) expect(stderr).toContain(name);
    },
    60_000,
  );

  it(
    '一部だけ供給されていても走らない（us-east-1 の exec だけ欠けている場合）',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        ...NO_RETIRED_ARNS,
        SIMULATE_EXEC_ROLE_ARN_US_EAST_1: undefined,
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_EXEC_ROLE_ARN_US_EAST_1');
      // 🔴 R4 の中心。region ごとに鍵が分かれていなければ、ap-northeast-1 の exec を
      // 渡しただけで「exec は供給済み」になり、us-east-1 が未検証のまま通ってしまう。
      expect(stderr).not.toContain('SIMULATE_EXEC_ROLE_ARN_AP_NORTHEAST_1');
    },
    60_000,
  );

  // 空文字は「供給された」ではない（[[空文字は「問題なし」ではない]]）。
  it(
    '空文字の ARN は未供給として扱う（未展開の環境変数を素通りさせない）',
    () => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        ...NO_RETIRED_ARNS,
        SIMULATE_EXEC_ROLE_ARN_US_EAST_1: '',
      });
      expect(status).toBe(2);
      expect(stderr).toContain('SIMULATE_EXEC_ROLE_ARN_US_EAST_1');
    },
    60_000,
  );

  it.each([
    ['SIMULATE_PRINCIPAL_ARN', 'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev'],
    // #680 R4: region 無しの旧変数も廃止。渡したまま走らせて「両 region 検証済み」と
    // 記録できないようにする。
    ['SIMULATE_DEPLOY_ROLE_ARN', 'arn:aws:iam::822063948773:role/x'],
    ['SIMULATE_EXEC_ROLE_ARN', 'arn:aws:iam::822063948773:role/y'],
  ])(
    '廃止された %s が設定されていたら明示的に止める',
    (name, value) => {
      const { status, stderr } = run(['--simulate-only'], {
        ...FAKE_ARNS,
        ...NO_RETIRED_ARNS,
        [name]: value,
      });
      expect(status).toBe(2);
      expect(stderr).toContain(`${name} は廃止されました`);
    },
    60_000,
  );

  it(
    'principal が揃っていれば検証を通過し、AWS 呼び出しの直前でインターロックが止める',
    () => {
      const { status, stderr } = run(['--simulate-only'], { ...FAKE_ARNS, ...NO_RETIRED_ARNS });
      // exit 3 = インターロック専用（2 = 引数エラー / 1 = 検査 FAIL と区別する）。
      // ここが 2 のままなら、principal 検証が「揃っている」を認識できていない。
      expect(status).toBe(3);
      expect(stderr).toContain('VITEST 実行中のため AWS を呼びません');
    },
    60_000,
  );
});

describe('SIMULATED_CHECKS は全件が principal と region を宣言している (Critical 3 / #680 R4)', () => {
  const block = extractFunctionBody(SOURCE, 'const SIMULATED_CHECKS', 'const PRINCIPAL_ENV_VARS');
  const ids = [...block.matchAll(/^\s*id: '(S\d+)',/gm)].map((m) => m[1]!);

  it('各 check が principals / coverage / expected を持つ（id と同数）', () => {
    // 🔴 0 件なら空虚に真になる。抽出できていることを先に固定する。
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const field of [/^\s*principals: \[/gm, /^\s*coverage: /gm, /^\s*expected: /gm]) {
      expect([...block.matchAll(field)].length).toBe(ids.length);
    }
  });

  it('boundary 脱出系（S4/S5/S7）は exec に対して評価される', () => {
    for (const id of ['S4', 'S5', 'S7']) {
      const start = block.indexOf(`id: '${id}',`);
      if (start === -1) throw new Error(`SIMULATED_CHECKS に ${id} が見つかりません`);
      const entry = block.slice(start, block.indexOf('},', start));
      expect(entry).toContain("'exec'");
    }
  });

  /**
   * 🔴 **R4 の中心。** リソース ARN に region がハードコードされていると、
   * `--policy-source-arn` を us-east-1 版に差し替えても評価対象は ap-northeast-1 のまま
   * になる（「us-east-1 検証済み」という嘘の記録がここから生まれた）。
   * region を持つリソース ARN は必ず `resource: (r) => ...` のテンプレートで組む。
   */
  it('リソース ARN に region をハードコードしていない（region 関数から組む）', () => {
    // `coverage: { kind: 'only', region: ... }` の宣言行は対象外（そこは region そのもの）。
    const resourceLines = block
      .split('\n')
      .filter((l) => /resource: /.test(l) || /^\s+`arn:aws:/.test(l));
    expect(resourceLines.length).toBeGreaterThan(0);
    for (const line of resourceLines) {
      // 例外は「us-east-1 にしか無いリソース」を明示している S15 / S16 のみ。
      if (line.includes('CfMonitoring-dev') || line.includes('claude-gate-')) continue;
      expect(line).not.toContain('ap-northeast-1');
      expect(line).not.toContain('us-east-1');
    }
  });

  it('片 region しか覆わない check は理由を書いている', () => {
    for (const m of block.matchAll(/kind: 'only',/g)) {
      const entry = block.slice(m.index, m.index + 400);
      expect(entry).toMatch(/reason: /);
    }
  });

  /**
   * carve-out（#680 R2）は **allowed を期待する対**が無いと意味を成さない。
   * 「carve-out が効いている（S17/S19 = allowed）」と「広すぎない（S18/S20 = denied）」の
   * 両方が揃っていることを固定する ―― 片方だけだと、carve-out を消しても
   * carve-out を `*` に広げても、どちらかが緑のままになる。
   */
  it('carve-out は allowed / denied の対で検査している', () => {
    const expectationOf = (id: string): string => {
      const start = block.indexOf(`id: '${id}',`);
      if (start === -1) throw new Error(`SIMULATED_CHECKS に ${id} が見つかりません`);
      const entry = block.slice(start, block.indexOf('guards:', start));
      const m = /expected: '(allowed|denied)'/.exec(entry);
      if (m === null) throw new Error(`${id} に expected がありません`);
      return m[1]!;
    };
    expect(['S17', 'S18', 'S19', 'S20'].map(expectationOf)).toEqual([
      'allowed',
      'denied',
      'allowed',
      'denied',
    ]);
  });

  /**
   * 🔴 **#680 R10 / D: `iam:PassRole` の対を足した。**
   *
   * これまで「`iam:PassedToService` は `--context-entries` 無しでは渡せない」という
   * 理由で S 系から落とし、runbook に「覆っていない」と書いていた。実際には渡せる。
   * **対の両方が同じ context を渡している**ことも固定する ―― denied の側だけ context を
   * 落とすと、「タグ条件が効いた」のか「context が無かった」のか区別できなくなる。
   */
  it('PassRole は同じ context を渡した allowed / denied の対で検査している', () => {
    const entryOf = (id: string): string => {
      const start = block.indexOf(`id: '${id}',`);
      if (start === -1) throw new Error(`SIMULATED_CHECKS に ${id} が見つかりません`);
      return block.slice(start, block.indexOf('guards:', start));
    };
    const facts = ['S21', 'S22'].map((id) => {
      const entry = entryOf(id);
      return {
        id,
        action: /action: '([^']+)'/.exec(entry)?.[1],
        expected: /expected: '(allowed|denied)'/.exec(entry)?.[1],
        hasPassedToService: entry.includes('ContextKeyName=iam:PassedToService'),
        hasLambdaValue: entry.includes('ContextKeyValues=lambda.amazonaws.com'),
      };
    });
    expect(facts).toEqual([
      { id: 'S21', action: 'iam:PassRole', expected: 'allowed', hasPassedToService: true, hasLambdaValue: true },
      { id: 'S22', action: 'iam:PassRole', expected: 'denied', hasPassedToService: true, hasLambdaValue: true },
    ]);
  });

  it('既定の principal ARN をソース中に持たない（1 本で全部を評価する形へ戻さない）', () => {
    expect(SOURCE).not.toContain('process.env.SIMULATE_PRINCIPAL_ARN ??');
  });
});
