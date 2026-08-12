import { describe, expect, it } from 'vitest';
import {
  findUnsuppliedPrincipals,
  resolvePrincipalArn,
  classifyAwsError,
  classifySimulationError,
  resolveExecutionScope,
  summarizeNegativeTests,
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
describe('S 系の principal 解決 (Critical 3)', () => {
  it('供給されていない principal を列挙する', () => {
    expect(findUnsuppliedPrincipals(['entry', 'deploy', 'exec'], { entry: 'arn:aws:iam::1:role/e' })).toEqual([
      'deploy',
      'exec',
    ]);
  });

  it('必要としていない principal は欠けていても列挙しない', () => {
    expect(findUnsuppliedPrincipals(['exec'], { exec: 'arn:aws:iam::1:role/x' })).toEqual([]);
  });

  it('重複した要求は 1 件にまとめる', () => {
    expect(findUnsuppliedPrincipals(['exec', 'exec', 'deploy'], {})).toEqual(['deploy', 'exec']);
  });

  // [[空文字は「問題なし」ではない]]: 未展開の環境変数を「供給された」と読まない。
  it.each(['', '   '])('空文字・空白のみの ARN は「供給されていない」と扱う: %j', (arn) => {
    expect(findUnsuppliedPrincipals(['exec'], { exec: arn })).toEqual(['exec']);
    expect(resolvePrincipalArn('exec', { exec: arn })).toBeNull();
  });

  it('供給されていれば trim した ARN を返す', () => {
    expect(resolvePrincipalArn('deploy', { deploy: ' arn:aws:iam::1:role/d ' })).toBe('arn:aws:iam::1:role/d');
  });

  it('供給されていなければ null を返す（既定値で埋めない）', () => {
    expect(resolvePrincipalArn('deploy', {})).toBeNull();
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
