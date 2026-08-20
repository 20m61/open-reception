/**
 * イベント上限を「通話ごと」ではなく「取次全体」で数える (#646 スライス 1)。
 *
 * ## なぜ先に要るのか
 *
 * #646 の 2 手目は **新しい `providerCallId`** を持つ。相関は `providerCallId` がキーなので
 * （`call-correlation.ts`）、2 手目は**新しいレコード**になる。ところが `eventCount` は
 * `correlation.eventCount` から読まれるので、**新レコードでは必ず 0 にリセットされる**。
 *
 * 🔴 つまり 2 手目を配線した瞬間、上限は `1 通話 100 イベント × 最大 10 hop = 実質 1000` まで
 * 緩む。webhook は**認証を持たない公開エンドポイント**で、上限は ledger が DynamoDB の
 * item サイズ上限（400KB）へ育つのを止めるために置かれている（`webhook-advance.ts`）。
 * 発信を繋ぐ前にここを固める。
 *
 * `hops` と `ledger` は `RoutingPosition` に載っていて position ごと引き継げば取次全体で
 * 効くので、**`eventCount` も同じ場所へ載せる**のが素直（ユーザー判断）。
 */
import { describe, expect, it } from 'vitest';
import { eventBudgetOf, withEventBudget } from './hop-event-budget';
import type { RoutingPosition } from './resumable';

const position = (extra: Partial<RoutingPosition> = {}): RoutingPosition => ({
  callUuid: 'call-1',
  policyId: 'policy-1',
  stepId: 'step-1',
  hops: 1,
  ledger: ['jti-1'],
  ...extra,
});

describe('eventBudgetOf (#646)', () => {
  it('🔴 position に載っていれば、それを使う（取次全体で数える）', () => {
    expect(eventBudgetOf(position({ eventCount: 7 }), 0)).toBe(7);
  });

  /**
   * 🔴 **旧レコードを読めること。** `position.eventCount` を持たない相関は TTL 6 時間で
   * 入れ替わるが、その間に読めなくなると進行中の取次が落ちる。
   * 永続スキーマの追加を「互換」と言うための条件そのもの（`.claude/rules`）。
   */
  it('🔴 position に無ければ相関側の値へ倒す（旧レコード互換）', () => {
    expect(eventBudgetOf(position(), 5)).toBe(5);
  });

  it('どちらも無ければ 0', () => {
    expect(eventBudgetOf(position(), undefined)).toBe(0);
  });

  it('position の 0 を「未設定」と取り違えない', () => {
    // `||` で書くと 99 へ倒れる。0 は「未設定」ではなく正当な値。
    expect(eventBudgetOf(position({ eventCount: 0 }), 99)).toBe(0);
  });
});

describe('withEventBudget (#646)', () => {
  it('🔴 position へ書き戻す（次の手が引き継げる）', () => {
    expect(withEventBudget(position(), 3).eventCount).toBe(3);
  });

  it('他のフィールドを壊さない', () => {
    const next = withEventBudget(position({ hops: 4, ledger: ['a', 'b'] }), 9);
    expect(next.hops).toBe(4);
    expect(next.ledger).toEqual(['a', 'b']);
    expect(next.callUuid).toBe('call-1');
  });

  /**
   * 🔴 **これが本体。** 2 手目の相関は新規レコードだが、position を引き継げば
   * イベント数は続きから数わる。引き継がないと上限が hop 数だけ緩む。
   */
  it('🔴 引き継いだ position から読めば、通話をまたいで続きから数える', () => {
    const afterFirstCall = withEventBudget(position(), 40);
    // 2 手目は新しい相関（eventCount フィールドは 0 から始まる）だが position は引き継ぐ。
    expect(eventBudgetOf(afterFirstCall, 0)).toBe(40);
  });
});
