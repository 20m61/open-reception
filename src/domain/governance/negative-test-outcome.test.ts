import { describe, expect, it } from 'vitest';
import {
  coveredRegions,
  findUnsuppliedPrincipalKeys,
  isRegionalPrincipal,
  principalArnKey,
  resolvePrincipalArnByKey,
  uncoveredRegionNote,
  classifyAwsError,
  classifySimulationError,
  classifyProbeVerdict,
  evalDecisionToOutcome,
  isUnexplainedImplicitDeny,
  parseEvalDecision,
  resolveExecutionScope,
  summarizeNegativeTests,
  SIMULATION_REGIONS,
} from './negative-test-outcome';

/**
 * `scripts/aws-negative-tests.ts` の判定部分（純関数）。
 *
 * 🔴 このスクリプト全体は AWS 認証情報が無いと動かず、本サイクルでは一度も実走しない。
 * 実走しないコードをテスト無しで置かないため、判定ロジックをここへ切り出して固定する。
 */

describe('classifyAwsError', () => {
  it.each(['AccessDenied', 'accessdenied', 'An error occurred (AccessDenied)'])(
    'AccessDenied を含む stderr は denied: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it.each(['not authorized', 'NOT AUTHORIZED to perform', 'User is not Authorized'])(
    'not authorized を含む stderr は denied（大小無視）: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it.each(['explicit deny', 'with an explicit deny in an identity-based policy'])(
    'explicit deny を含む stderr は denied（大小無視）: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it('空文字は unknown（[[空文字は「問題なし」ではない]] の型。DENY_PATTERN が空文字に一致しないことで担保される）', () => {
    expect(classifyAwsError('')).toBe('unknown');
  });

  it('拒否シグナルを含まない stderr は unknown（判定不能を勝手に denied にしない）', () => {
    expect(classifyAwsError('Could not connect to the endpoint URL')).toBe('unknown');
  });

  it('ThrottlingException のような無関係なエラーも unknown', () => {
    expect(classifyAwsError('An error occurred (ThrottlingException)')).toBe('unknown');
  });
});

describe('classifySimulationError（CRITICAL 1 の回帰テスト）', () => {
  // `simulate()`（iam:SimulatePrincipalPolicy 呼び出し）が失敗しても、それは
  // 「評価対象アクションが denied だった」ことを意味しない。`classifyAwsError` と違い、
  // stderr に AccessDenied 系の文字列が含まれていても **常に unknown** を返さなければならない。
  it.each(['AccessDenied', 'An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy'])(
    'AccessDenied を含む stderr でも denied にしない（SimulatePrincipalPolicy 自体への denied と評価対象への denied を混同しない）: %s',
    (stderr) => {
      expect(classifySimulationError(stderr)).toBe('unknown');
    },
  );

  it('拒否シグナルを含まない stderr も unknown', () => {
    expect(classifySimulationError('Could not connect to the endpoint URL')).toBe('unknown');
  });

  it('空文字も unknown', () => {
    expect(classifySimulationError('')).toBe('unknown');
  });

  it('unevaluable な simulation（classifySimulationError の出力）は summarizeNegativeTests で決して PASS 扱いにならない', () => {
    // S1〜S10 は全部 expected: 'denied'。SimulatePrincipalPolicy 自体が呼べなかった
    // （＝評価不能）場合に、それが「denied だったので PASS」に化けないことを、
    // classifySimulationError → summarizeNegativeTests の実際の合成で固定する。
    const actual = classifySimulationError('AccessDenied: SimulatePrincipalPolicy');
    const result = summarizeNegativeTests([{ id: 'S1', expected: 'denied', actual }]);
    expect(result).toEqual({ failed: 1, misdirected: 0 });
  });
});

describe('summarizeNegativeTests', () => {
  it('全件一致なら failed=0', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'denied' },
      { id: 'N2', expected: 'allowed', actual: 'allowed' },
    ]);
    expect(result).toEqual({ failed: 0, misdirected: 0 });
  });

  it('期待と異なれば failed をカウントする', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'allowed' },
      { id: 'N2', expected: 'allowed', actual: 'allowed' },
    ]);
    expect(result).toEqual({ failed: 1, misdirected: 0 });
  });

  it('unknown は expected が denied でも PASS にしない（判定不能を PASS にしない）', () => {
    const result = summarizeNegativeTests([{ id: 'N1', expected: 'denied', actual: 'unknown' }]);
    expect(result).toEqual({ failed: 1, misdirected: 0 });
  });

  it('unknown は expected が allowed でも PASS にしない', () => {
    const result = summarizeNegativeTests([{ id: 'N4', expected: 'allowed', actual: 'unknown' }]);
    expect(result).toEqual({ failed: 1, misdirected: 0 });
  });

  it('複数件の failed を正しく合算する', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'unknown' },
      { id: 'N2', expected: 'denied', actual: 'allowed' },
      { id: 'N3', expected: 'allowed', actual: 'allowed' },
      { id: 'N4', expected: 'denied', actual: 'denied' },
    ]);
    expect(result).toEqual({ failed: 2, misdirected: 0 });
  });

  it('空配列は failed=0', () => {
    expect(summarizeNegativeTests([])).toEqual({ failed: 0, misdirected: 0 });
  });
});

/**
 * 🔴 Critical 3（2026-08-12 全体レビュー）: S 系は「1 本の principal ARN」で評価していた。
 * 既定は entry role で、entry role は 4 アクション以外を最初から全 Deny するため、
 * `claude-boundary.json` / `claude-cfn-exec.json` が存在しなくても S1〜S11 は全部
 * `denied` を返した ―― **落ちようのない検査**だった。
 */
describe('S 系の principal 解決 (Critical 3 / #680 R4)', () => {
  const KEYS = ['entry', 'deploy@ap-northeast-1', 'exec@us-east-1'];

  it('供給されていない鍵を列挙する', () => {
    expect(findUnsuppliedPrincipalKeys(KEYS, { entry: 'arn:aws:iam::1:role/e' })).toEqual([
      'deploy@ap-northeast-1',
      'exec@us-east-1',
    ]);
  });

  it('必要としていない鍵は欠けていても列挙しない', () => {
    expect(
      findUnsuppliedPrincipalKeys(['exec@us-east-1'], { 'exec@us-east-1': 'arn:aws:iam::1:role/x' }),
    ).toEqual([]);
  });

  it('重複した要求は 1 件にまとめ、宣言順を保つ', () => {
    expect(
      findUnsuppliedPrincipalKeys(['exec@us-east-1', 'exec@us-east-1', 'deploy@ap-northeast-1'], {}),
    ).toEqual(['exec@us-east-1', 'deploy@ap-northeast-1']);
  });

  // [[空文字は「問題なし」ではない]]: 未展開の環境変数を「供給された」と読まない。
  it.each(['', '   '])('空文字・空白のみの ARN は「供給されていない」と扱う: %j', (arn) => {
    expect(findUnsuppliedPrincipalKeys(['exec@us-east-1'], { 'exec@us-east-1': arn })).toEqual([
      'exec@us-east-1',
    ]);
    expect(resolvePrincipalArnByKey('exec@us-east-1', { 'exec@us-east-1': arn })).toBeNull();
  });

  it('供給されていれば trim した ARN を返す', () => {
    expect(
      resolvePrincipalArnByKey('deploy@us-east-1', { 'deploy@us-east-1': ' arn:aws:iam::1:role/d ' }),
    ).toBe('arn:aws:iam::1:role/d');
  });

  it('供給されていなければ null を返す（既定値で埋めない）', () => {
    expect(resolvePrincipalArnByKey('deploy@us-east-1', {})).toBeNull();
  });

  /**
   * 🔴 **R4 の中心。** `entry` は IAM ロール 1 本なので region で分けない。
   * `deploy` / `exec` は bootstrap が region ごとに作る別のロールなので、
   * **鍵が region を含まなければ片方しか検証していないことに気づけない**。
   */
  it('deploy / exec は region ごとに別の鍵になり、entry は region で分かれない', () => {
    expect(SIMULATION_REGIONS.map((r) => principalArnKey('entry', r))).toEqual(['entry', 'entry']);
    expect(SIMULATION_REGIONS.map((r) => principalArnKey('deploy', r))).toEqual([
      'deploy@ap-northeast-1',
      'deploy@us-east-1',
    ]);
    expect(SIMULATION_REGIONS.map((r) => principalArnKey('exec', r))).toEqual([
      'exec@ap-northeast-1',
      'exec@us-east-1',
    ]);
    expect(isRegionalPrincipal('entry')).toBe(false);
    expect(isRegionalPrincipal('deploy')).toBe(true);
    expect(isRegionalPrincipal('exec')).toBe(true);
  });
});

/**
 * 🔴 **R4（#680 残件レビュー）: 「us-east-1 も検証した」という嘘を構造で防ぐ。**
 *
 * 旧 runbook 4a は `-us-east-1` 版の ARN で 2 回目を走らせろと指示していたが、
 * リソース ARN は全部 ap-northeast-1 にハードコードされていたため、変わるのは
 * `--policy-source-arn` だけだった。覆っていない region は**出力に理由つきで現れる**。
 */
describe('region coverage (#680 R4)', () => {
  it('both は両 region を返し、未評価の注記を出さない', () => {
    expect(coveredRegions({ kind: 'both' })).toEqual(['ap-northeast-1', 'us-east-1']);
    expect(uncoveredRegionNote({ kind: 'both' })).toBeNull();
  });

  it('only は 1 region だけを返し、覆っていない region と理由を注記する', () => {
    const coverage = {
      kind: 'only',
      region: 'us-east-1',
      reason: 'CfMonitoring-dev は us-east-1 にしか無い',
    } as const;
    expect(coveredRegions(coverage)).toEqual(['us-east-1']);
    expect(uncoveredRegionNote(coverage)).toBe(
      'ap-northeast-1 は未評価: CfMonitoring-dev は us-east-1 にしか無い',
    );
  });

  it('注記には理由がそのまま含まれる（「未評価」とだけ書いて済ませない）', () => {
    const note = uncoveredRegionNote({
      kind: 'only',
      region: 'ap-northeast-1',
      reason: 'nodi は ap-northeast-1 にしか存在しない',
    });
    expect(note).toContain('us-east-1 は未評価');
    expect(note).toContain('nodi は ap-northeast-1 にしか存在しない');
  });
});

describe('誤った principal に対する評価は採点せず棄却する (Critical 3)', () => {
  const EXEC = 'arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1';
  const ENTRY = 'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev';

  it('意図した principal で評価されていれば通常どおり採点する', () => {
    expect(
      summarizeNegativeTests([
        { id: 'S4[exec]', expected: 'denied', actual: 'denied', requiredPrincipalArn: EXEC, evaluatedPrincipalArn: EXEC },
      ]),
    ).toEqual({ failed: 0, misdirected: 0 });
  });

  // これが Critical 3 の核心。entry role に対して boundary 脱出（S4）を聞くと必ず
  // `denied` が返るが、それは boundary が効いている証拠ではない。**denied でも PASS にしない。**
  it('exec を要求する検査を entry で評価したら、denied でも PASS にしない', () => {
    expect(
      summarizeNegativeTests([
        { id: 'S4[exec]', expected: 'denied', actual: 'denied', requiredPrincipalArn: EXEC, evaluatedPrincipalArn: ENTRY },
      ]),
    ).toEqual({ failed: 1, misdirected: 1 });
  });

  it('評価した principal が記録されていない場合も棄却する', () => {
    expect(
      summarizeNegativeTests([
        { id: 'S4[exec]', expected: 'denied', actual: 'denied', requiredPrincipalArn: EXEC },
      ]),
    ).toEqual({ failed: 1, misdirected: 1 });
  });

  it('N 系（principal を持たない live check）は従来どおり採点する', () => {
    expect(summarizeNegativeTests([{ id: 'N1', expected: 'allowed', actual: 'allowed' }])).toEqual({
      failed: 0,
      misdirected: 0,
    });
  });

  it('棄却と通常の不一致は合算されるが、misdirected は棄却分だけを数える', () => {
    expect(
      summarizeNegativeTests([
        { id: 'S1[exec]', expected: 'denied', actual: 'denied', requiredPrincipalArn: EXEC, evaluatedPrincipalArn: ENTRY },
        { id: 'S2[exec]', expected: 'denied', actual: 'allowed', requiredPrincipalArn: EXEC, evaluatedPrincipalArn: EXEC },
        { id: 'N1', expected: 'allowed', actual: 'allowed' },
      ]),
    ).toEqual({ failed: 2, misdirected: 1 });
  });
});

describe('resolveExecutionScope', () => {
  it('どちらも指定なしなら all（live + simulate 全件）', () => {
    expect(resolveExecutionScope(false, false)).toBe('all');
  });

  it('--simulate-only のみなら simulate', () => {
    expect(resolveExecutionScope(true, false)).toBe('simulate');
  });

  it('--live-only のみなら live', () => {
    expect(resolveExecutionScope(false, true)).toBe('live');
  });

  it('両方同時指定は矛盾として null を返す（呼び出し側が非ゼロで終了する）', () => {
    expect(resolveExecutionScope(true, true)).toBeNull();
  });
});

/**
 * 🔴 defect 2（#680 フォローアップ）: `S16`（changeSet ARN への `DescribeChangeSet`、
 * `expected: 'allowed'`）は実測で常に `implicitDeny` を返す ―― `claude-deploy-entry.json`
 * ではなく、IAM のポリシーシミュレータが CloudFormation の `changeset` リソース種別を
 * 評価できないため（`Resource: "*"` の最小 Allow でも `implicitDeny`）。
 * `S15`/`S16` へのハードコードした exemption ではなく、`expected: 'allowed'` の check が
 * `implicitDeny` を返したときだけ probe を打つ、という測定に落とす。
 */
describe('parseEvalDecision', () => {
  it.each(['allowed', 'explicitDeny', 'implicitDeny'] as const)(
    '3 値のいずれかはそのまま返す: %s',
    (v) => {
      expect(parseEvalDecision(v)).toBe(v);
    },
  );

  it('前後の空白は trim する', () => {
    expect(parseEvalDecision('  allowed\n')).toBe('allowed');
  });

  it('空文字は null（denied 相当に丸めない）', () => {
    expect(parseEvalDecision('')).toBeNull();
  });

  it('想定外の値は null', () => {
    expect(parseEvalDecision('maybe')).toBeNull();
  });
});

describe('evalDecisionToOutcome', () => {
  it('allowed → allowed', () => {
    expect(evalDecisionToOutcome('allowed')).toBe('allowed');
  });

  it.each(['explicitDeny', 'implicitDeny'] as const)('%s → denied（どちらも denied に写像する）', (d) => {
    expect(evalDecisionToOutcome(d)).toBe('denied');
  });

  it('null → unknown', () => {
    expect(evalDecisionToOutcome(null)).toBe('unknown');
  });
});

describe('isUnexplainedImplicitDeny（probe を打つべきかどうかのゲート）', () => {
  it('expected=allowed かつ implicitDeny のときだけ true', () => {
    expect(isUnexplainedImplicitDeny('allowed', 'implicitDeny')).toBe(true);
  });

  it('expected=denied なら implicitDeny でも false（正当な PASS であり probe は無意味）', () => {
    expect(isUnexplainedImplicitDeny('denied', 'implicitDeny')).toBe(false);
  });

  it('expected=allowed でも explicitDeny なら false（一致するステートメントがあった）', () => {
    expect(isUnexplainedImplicitDeny('allowed', 'explicitDeny')).toBe(false);
  });

  it('expected=allowed でも allowed 自体なら false（そのまま PASS）', () => {
    expect(isUnexplainedImplicitDeny('allowed', 'allowed')).toBe(false);
  });

  it('decision が null（判定不能の API 失敗）なら false（unknown を probe の入口にしない）', () => {
    expect(isUnexplainedImplicitDeny('allowed', null)).toBe(false);
  });
});

describe('classifyProbeVerdict', () => {
  it('probe が implicitDeny なら unsimulatable（最小 Allow でも一致しない＝シミュレータ未対応）', () => {
    expect(classifyProbeVerdict('implicitDeny')).toBe('unsimulatable');
  });

  it('probe が allowed なら supported（シミュレータは機能している。通常どおり FAIL 採点へ戻す）', () => {
    expect(classifyProbeVerdict('allowed')).toBe('supported');
  });

  it('probe が explicitDeny なら supported（一致するステートメントがあった＝評価できている）', () => {
    expect(classifyProbeVerdict('explicitDeny')).toBe('supported');
  });

  it('probe 自体が失敗した（null）なら supported ―― unsimulatable 側へ倒さない', () => {
    // 🔴 ここが「一般的な逃げ道」にならないための核心。probe の API 呼び出しが
    // 失敗しただけなのに「シミュレータの限界」に化けさせると、本物の権限不足を
    // 隠す一般的な逃げ道になる。probe が失敗したら通常の FAIL 採点へフォールバックする。
    expect(classifyProbeVerdict(null)).toBe('supported');
  });
});
