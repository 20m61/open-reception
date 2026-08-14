/**
 * 承認トークン（#680）の性質を固定する。
 *
 * diff gate は `resourceReplacement` / `resourceRemoval` 等で**必ず止まる**。
 * 人間がその差分を見て承認したときだけ deploy を通すために、
 * 「**その findings に固定された**トークン」を導入した。
 *
 * ここで守りたいのは 1 つだけ: **承認は差分に紐づき、使い回せない**。
 */
import { describe, expect, it } from 'vitest';
import { approvalToken, isApproved } from './deploy-approval-token';
import type { DeployBlock } from './deploy-diff-gate';

const STACK = 'OpenReception-Web-dev';

const BLOCKS: readonly DeployBlock[] = [
  { reason: 'resourceRemoval', evidence: 'ServerFninvokefunctionA3A7399A (AWS::Lambda::Permission) action=Remove' },
  { reason: 'resourceReplacement', evidence: 'ServerFnFunctionUrlFFF9E3E1 (AWS::Lambda::Url) action=Modify' },
];

describe('approvalToken', () => {
  it('スタック名を含み、同じ findings なら安定して同じ値になる', () => {
    expect(approvalToken(STACK, BLOCKS)).toBe(approvalToken(STACK, BLOCKS));
    expect(approvalToken(STACK, BLOCKS)).toMatch(/^OpenReception-Web-dev:[0-9a-f]{16}$/);
  });

  it('findings の並び順が違っても同じ値になる（順序で承認が無効化されない）', () => {
    expect(approvalToken(STACK, [...BLOCKS].reverse())).toBe(approvalToken(STACK, BLOCKS));
  });

  it('🔴 findings が 1 件でも増えたら別の値になる', () => {
    const more: DeployBlock[] = [...BLOCKS, { reason: 'publicInvokePermission', evidence: 'X (Y) action=Add' }];
    expect(approvalToken(STACK, more)).not.toBe(approvalToken(STACK, BLOCKS));
  });

  it('🔴 evidence が変わったら別の値になる（reason だけで潰さない）', () => {
    const changed: DeployBlock[] = [{ ...BLOCKS[0]!, evidence: 'まったく別のリソース' }, BLOCKS[1]!];
    expect(approvalToken(STACK, changed)).not.toBe(approvalToken(STACK, BLOCKS));
  });

  it('🔴 スタックが違えば別の値になる', () => {
    expect(approvalToken('OpenReception-WebMonitoring-dev', BLOCKS)).not.toBe(approvalToken(STACK, BLOCKS));
  });
});

describe('isApproved', () => {
  const token = approvalToken(STACK, BLOCKS);

  it('一致するトークンが渡されていれば承認済みと判定する', () => {
    expect(isApproved(STACK, BLOCKS, token)).toBe(true);
  });

  it('複数スタックぶんをカンマ区切りで渡せる（空白は許容）', () => {
    const other = approvalToken('OpenReception-CfMonitoring-dev', BLOCKS);
    expect(isApproved(STACK, BLOCKS, ` ${other} , ${token} `)).toBe(true);
  });

  it('🔴 未設定なら承認しない', () => {
    expect(isApproved(STACK, BLOCKS, undefined)).toBe(false);
  });

  it('🔴 空文字なら承認しない', () => {
    expect(isApproved(STACK, BLOCKS, '')).toBe(false);
    expect(isApproved(STACK, BLOCKS, '   ')).toBe(false);
  });

  it('🔴 findings が変わったら古いトークンは効かない', () => {
    const more: DeployBlock[] = [...BLOCKS, { reason: 'publicInvokePermission', evidence: 'X (Y) action=Add' }];
    expect(isApproved(STACK, more, token)).toBe(false);
  });

  it('🔴 別スタックのトークンでは承認されない', () => {
    const other = approvalToken('OpenReception-WebMonitoring-dev', BLOCKS);
    expect(isApproved(STACK, BLOCKS, other)).toBe(false);
  });

  it('🔴 ワイルドカード的な値は効かない（完全一致のみ）', () => {
    for (const wild of ['*', `${STACK}:*`, '*:*', token.slice(0, -1) + '*']) {
      expect(isApproved(STACK, BLOCKS, wild)).toBe(false);
    }
  });

  it('🔴 ブロックが 0 件のときは承認済みを返さない（「承認された」と「そもそも止まっていない」を混ぜない）', () => {
    expect(isApproved(STACK, [], approvalToken(STACK, []))).toBe(false);
    expect(isApproved(STACK, [], '')).toBe(false);
  });
});
