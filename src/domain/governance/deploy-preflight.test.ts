/**
 * preflight の判定 (spec §5)。
 *
 * **1 つでも不一致なら止める。** 環境判定ミス（脅威 T13）はここでしか捕まらない。
 * 観測は呼び出し側（`scripts/aws-cloud-deploy.sh`）が集め、判定はここが行う。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFLIGHT_REQUIREMENT,
  evaluatePreflight,
  type PreflightObservation,
} from './deploy-preflight';

const ok = (over: Partial<PreflightObservation> = {}): PreflightObservation => ({
  callerArn: 'arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/cloud-session',
  accountId: '822063948773',
  region: 'ap-northeast-1',
  qualifier: 'orcloud01',
  environment: 'dev',
  credentialSecondsRemaining: 3600,
  workingTreeClean: true,
  gateStampSatisfied: true,
  negativeTestsPassed: true,
  ...over,
});

describe('全部そろえば通る', () => {
  it('deploy まで許可される', () => {
    const verdict = evaluatePreflight(ok(), DEFAULT_PREFLIGHT_REQUIREMENT);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('1 つでも不一致なら止める', () => {
  it.each<[string, Partial<PreflightObservation>, string]>([
    ['別アカウント', { accountId: '111122223333' }, 'accountId'],
    ['別リージョン', { region: 'us-west-2' }, 'region'],
    ['既定 qualifier', { qualifier: 'hnb659fds' }, 'qualifier'],
    ['staging 環境', { environment: 'staging' }, 'environment'],
    ['prod 環境', { environment: 'prod' }, 'environment'],
    [
      '別ロール（人間の CDK user）',
      { callerArn: 'arn:aws:iam::822063948773:user/CDK' },
      'callerArn',
    ],
    [
      '似た名前のロール（部分一致で通さない）',
      {
        callerArn:
          'arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev-evil/x',
      },
      'callerArn',
    ],
    ['作業ツリーが dirty', { workingTreeClean: false }, 'workingTreeClean'],
    ['ゲート未実行', { gateStampSatisfied: false }, 'gateStampSatisfied'],
    ['negative test 未通過', { negativeTestsPassed: false }, 'negativeTestsPassed'],
    ['credential 残り 5 分', { credentialSecondsRemaining: 300 }, 'credentialSecondsRemaining'],
  ])('%s', (_name, over, field) => {
    const verdict = evaluatePreflight(ok(over), DEFAULT_PREFLIGHT_REQUIREMENT);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain(field);
  });

  it('複数の不一致をすべて報告する（最初の 1 件で打ち切らない）', () => {
    const verdict = evaluatePreflight(
      ok({ accountId: '111122223333', region: 'us-west-2' }),
      DEFAULT_PREFLIGHT_REQUIREMENT,
    );
    expect(verdict.failures.map((f) => f.field).sort()).toEqual(['accountId', 'region']);
  });

  it('不一致の根拠に観測値と期待値が載る', () => {
    const verdict = evaluatePreflight(ok({ accountId: '111122223333' }), DEFAULT_PREFLIGHT_REQUIREMENT);
    const detail = verdict.failures[0]!.detail;
    expect(detail).toContain('111122223333');
    expect(detail).toContain('822063948773');
  });
});

describe('credential 残時間の閾値は用途で変わる', () => {
  it('残り 25 分は diff には足りるが deploy には足りない', () => {
    expect(
      evaluatePreflight(ok({ credentialSecondsRemaining: 1500 }), {
        ...DEFAULT_PREFLIGHT_REQUIREMENT,
        minCredentialSeconds: 1200,
      }).ok,
    ).toBe(true);
    expect(
      evaluatePreflight(ok({ credentialSecondsRemaining: 1500 }), {
        ...DEFAULT_PREFLIGHT_REQUIREMENT,
        minCredentialSeconds: 2400,
      }).ok,
    ).toBe(false);
  });
});

describe('観測できていない値を PASS にしない', () => {
  it('credential 残時間が null なら止める（判定不能を通さない）', () => {
    const verdict = evaluatePreflight(
      ok({ credentialSecondsRemaining: null }),
      DEFAULT_PREFLIGHT_REQUIREMENT,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain('credentialSecondsRemaining');
  });

  // null 判定が閾値と独立していることを固定する。
  // `(observed.credentialSecondsRemaining ?? 0) < required.minCredentialSeconds` のような
  // 退化を許さない — そうなると minCredentialSeconds: 0 のケースで null が通ってしまい、
  // 「判定できていない」と「時間が足りた」の区別が失われる。
  it('minCredentialSeconds が 0 でも null は止める（?? 0 への退化を許さない）', () => {
    const verdict = evaluatePreflight(ok({ credentialSecondsRemaining: null }), {
      ...DEFAULT_PREFLIGHT_REQUIREMENT,
      minCredentialSeconds: 0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain('credentialSecondsRemaining');
  });

  // 🔴 Important 4（2026-08-12 レビュー）: `credentialSecondsRemaining` フィールドが
  // JSON に丸ごと欠落しているケース（`null` ではなく `undefined`）。呼び出し側
  // （`scripts/aws-preflight.ts`）は `JSON.parse(...) as PreflightObservation` で
  // 実行時の形を保証していないため、型定義上あり得ないはずの `undefined` が実際には
  // 起こり得る。厳密等価 `=== null` のままだと `undefined < required.minCredentialSeconds`
  // が常に false になり、判定不能が無条件で PASS してしまう。`== null` で拾えることを固定する。
  it('credentialSecondsRemaining キー自体が欠落（undefined）していても止める', () => {
    const { credentialSecondsRemaining: _drop, ...withoutKey } = ok();
    const verdict = evaluatePreflight(withoutKey as PreflightObservation, DEFAULT_PREFLIGHT_REQUIREMENT);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain('credentialSecondsRemaining');
  });
});
