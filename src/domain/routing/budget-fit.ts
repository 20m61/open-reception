/**
 * 取次の総所要時間と、端末が待つ上限の関係 (#743 AC4)。
 *
 * ## なぜ縛るのか
 *
 * hop 上限は 10（`DEFAULT_MAX_HOPS`）、1 手あたり `timeoutSeconds + 30s`（`dial-budget`）。
 * 端末は `CALL_STATUS_POLL_MAX_MS`（5 分）で待つのをやめる。**この 2 つの関係を
 * どこにも縛っていない**ので、運用者が手数や呼出時間を増やすと
 * 「iPad は諦めたのに社内の電話は鳴り続ける」が起きる。
 *
 * `/give-up`（#743 AC3）は端末の諦めをサーバへ届けるが、それは**事後の後始末**。
 * 設定の時点で収まらないと分かるなら、保存させる前に言うほうが安い。
 *
 * 純関数。永続化も HTTP も知らない。
 */
import { CALL_STATUS_POLL_MAX_MS } from '@/domain/reception/call-poll';
import { DIAL_BUDGET_MARGIN_SECONDS } from './dial-budget';

/**
 * この取次を最後まで撃ち切った場合の所要時間（ミリ秒）。
 *
 * 🔴 **余裕は 1 手ごとに掛ける。** webhook の配送遅延は毎回あるので、
 * 全体へ 1 回足すのでは足りない（実際の待ち時間を過小評価する）。
 */
export function routingWorstCaseMs(timeoutSecondsPerStep: readonly number[]): number {
  return timeoutSecondsPerStep.reduce(
    (total, seconds) => total + (seconds + DIAL_BUDGET_MARGIN_SECONDS) * 1000,
    0,
  );
}

/**
 * 端末が待つ上限に収まるか。
 *
 * 収まらない構成を保存させると、来訪者が代替導線へ倒れたあとも社内の電話が鳴り続ける。
 */
export function routingFitsClientWait(timeoutSecondsPerStep: readonly number[]): boolean {
  return routingWorstCaseMs(timeoutSecondsPerStep) <= CALL_STATUS_POLL_MAX_MS;
}
