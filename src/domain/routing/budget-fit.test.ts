/**
 * 取次の総所要時間が端末の待ち上限に収まること (#743 AC4)。
 *
 * ## 事実
 *
 * hop 上限は 10、1 手あたり `timeoutSeconds + 30s`。端末は
 * `CALL_STATUS_POLL_MAX_MS`（5 分）で待つのをやめる。**この 2 つの関係をどこにも
 * 縛っていない**ので、運用者が手数や呼出時間を増やすと
 * 「iPad は諦めたのに電話は鳴り続ける」が起きる。
 *
 * #743 で端末の諦めをサーバへ伝える経路（`/give-up`）は作ったが、それは**事後の後始末**。
 * 設定の時点で収まらないと分かるなら、保存させる前に言うべき。
 */
import { describe, expect, it } from 'vitest';
import { CALL_STATUS_POLL_MAX_MS } from '@/domain/reception/call-poll';
import { DIAL_BUDGET_MARGIN_SECONDS } from './dial-budget';
import { DEFAULT_MAX_HOPS } from './resumable';
import { routingWorstCaseMs, routingFitsClientWait } from './budget-fit';

describe('routingWorstCaseMs (#743)', () => {
  it('手ごとの呼出時間と余裕を足し合わせる', () => {
    // 2 手 × (20s + 30s) = 100s
    expect(routingWorstCaseMs([20, 20])).toBe(100_000);
  });

  it('手が無ければ 0', () => {
    expect(routingWorstCaseMs([])).toBe(0);
  });

  it('余裕は 1 手ごとに掛かる（webhook の配送遅延は毎回ある）', () => {
    expect(routingWorstCaseMs([10])).toBe((10 + DIAL_BUDGET_MARGIN_SECONDS) * 1000);
  });
});

describe('routingFitsClientWait (#743)', () => {
  it('端末の待ち上限に収まる構成は通す', () => {
    expect(routingFitsClientWait([20, 20, 30])).toBe(true);
  });

  /**
   * 🔴 **収まらない構成を黙って保存させない。** 収まらないと、来訪者が代替導線へ
   * 倒れたあとも社内の電話が鳴り続ける。
   */
  it('🔴 端末の待ち上限を超える構成は弾く', () => {
    // 10 手 × (60s + 30s) = 900s ≫ 300s
    expect(routingFitsClientWait(Array.from({ length: 10 }, () => 60))).toBe(false);
  });

  /**
   * 🔴 **既定の seed 構成は収まっていること。** ここが赤くなるなら、既定を出荷した時点で
   * 「iPad は諦めたのに電話は鳴り続ける」が起きる。
   */
  it('🔴 既定の取次（20 / 20 / 30 秒）は収まる', () => {
    expect(routingFitsClientWait([20, 20, 30])).toBe(true);
  });

  /**
   * 🔴 **上限どうしの関係そのものを固定する。** hop 上限まで使い切った最悪ケースが
   * 端末の待ち上限を超えるなら、`DEFAULT_MAX_HOPS` か端末上限のどちらかを見直す判断が要る。
   * この行を書き換えるときは、その判断を通すこと。
   *
   * **2026-08-21 に通した**（ユーザー判断）: `DEFAULT_MAX_HOPS` を 10 → 5 へ下げた。
   * 10 のときは 1 手あたりの予算が余裕（30 秒）と同じで、**呼出時間に 0 秒しか
   * 割けない**＝原理的に収まらなかった。5 なら 1 手 60 秒、うち呼出 30 秒を割ける。
   */
  it('🔴 hop 上限まで使った最悪ケースが端末上限に収まる呼出時間の上限を示す', () => {
    // 1 手あたり何秒までなら DEFAULT_MAX_HOPS 手すべて撃っても端末上限に収まるか。
    const perHopMs = CALL_STATUS_POLL_MAX_MS / DEFAULT_MAX_HOPS;
    const maxTimeoutSeconds = Math.floor(perHopMs / 1000) - DIAL_BUDGET_MARGIN_SECONDS;
    // 🔴 **正であること。** 0 以下＝余裕だけで予算を使い切る＝呼び出す時間が無い。
    expect(maxTimeoutSeconds).toBeGreaterThan(0);
    // その上限ちょうどの構成は収まり、1 秒でも超えると収まらない（境界が甘くない）。
    const atLimit = Array.from({ length: DEFAULT_MAX_HOPS }, () => maxTimeoutSeconds);
    expect(routingFitsClientWait(atLimit)).toBe(true);
    expect(routingFitsClientWait(atLimit.map((v, i) => (i === 0 ? v + 1 : v)))).toBe(false);
  });
});

/**
 * 既定値どうしが矛盾しないこと (#743)。
 *
 * 以前は `DEFAULT_MAX_HOPS = 10` で、**呼出 30 秒の構成なら余裕ぶんだけで端末の待ち上限を
 * 使い切る**計算だった ── 保存時のガードが弾く構成を、既定値が指し続けている状態。
 * 運用者は「10 手まで使える」と読むのに、保存しようとすると拒否される。
 */
describe('既定値どうしの整合 (#743)', () => {
  /** 🔴 これが本体。片方の定数を動かすと落ちる。 */
  it('🔴 呼出 30 秒 × DEFAULT_MAX_HOPS が端末の待ち上限に収まる', () => {
    const steps = Array.from({ length: DEFAULT_MAX_HOPS }, () => 30);
    expect(routingFitsClientWait(steps)).toBe(true);
  });

  /** 1 手増やすと超える ＝ 上限が「収まる最大」であることを示す（緩すぎない）。 */
  it('🔴 1 手増やすと超える（上限が緩すぎない）', () => {
    const steps = Array.from({ length: DEFAULT_MAX_HOPS + 1 }, () => 30);
    expect(routingFitsClientWait(steps)).toBe(false);
  });

  /** 既定 seed（20/20/30 秒 = 3 手）は従来どおり収まる。 */
  it('既定 seed の構成は収まる', () => {
    expect(routingFitsClientWait([20, 20, 30])).toBe(true);
  });
});
