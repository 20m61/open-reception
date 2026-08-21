/**
 * 「受付が終わったら取次も止まる」を明示的な不変条件にする (#743)。
 *
 * ## なぜ contract として置くのか
 *
 * これまで取次を止める判断は 3 箇所に散っていた:
 *
 *   - `dialNextHop` が撃つ前に受付が `'calling'` かを見る（#742 M1）
 *   - `repointProviderCall` が `'calling'` 条件付きで付け替える（#742 M2）
 *   - `advanceFromWebhook` が `settled` の相関では進めない
 *
 * どれも個別には正しいが、**「受付が終端したら取次は止まる」という一文がどこにも無い**。
 * そのため窓が開くたびに個別 patch を当てることになり、次の窓を予測できない。
 * ここは判断そのものを 1 箇所に置く。純関数で、永続化も HTTP も provider も知らない。
 *
 * ## 何を保証し、何を保証しないか
 *
 * 保証する（本モジュール ＋ 呼び出し側のテスト）:
 *   - 受付が terminal なら**新しい hop を撃たない**
 *   - 受付が terminal なら**相関を確定させる**（遅れて届く webhook で再開しない）
 *   - 来訪者のキャンセル・端末の諦め・運用者の停止を**同じ経路**で扱う
 *
 * 🔴 **保証しない**: すでに鳴っている provider 通話を**切る**こと。それは新しい外部副作用
 * （Vonage への発信以外の API 呼び出し）で、停止境界に当たる。よって本モジュールは
 * 「止めるべきだと判断された」ことまでを表し、切断は別の増分に分ける。
 * 切断が入るまでは、鳴ってしまった通話は呼出予算（`dialExpiresAt`）で自然に終わる。
 */

/** 取次を止める理由。**来訪者由来と運用由来を混ぜない**（監査で区別できるように）。 */
export const ROUTING_STOP_REASONS = [
  /** 来訪者が受付を取り消した。 */
  'visitor_cancel',
  /** 受付が終端した（未応答・失敗・完了）。 */
  'reception_terminal',
  /** 端末が待つのをやめた（`CALL_STATUS_POLL_MAX_MS` 到達）。 */
  'client_timeout',
  /** 運用者が止めた。 */
  'operator_stop',
] as const;

export type RoutingStopReason = (typeof ROUTING_STOP_REASONS)[number];

/**
 * 取次が進んでよい受付状態。**ここに無い状態はすべて「止める」**。
 *
 * 🔴 **許可リストで書く。** 禁止リストにすると、受付状態が増えたときに黙って
 * 「進んでよい」側へ入る（`fallback` を足したときに実際にそうなりかけた）。
 */
const ROUTING_ALLOWED_STATES: readonly string[] = ['calling'];

/** この受付状態で取次を続けてよいか。 */
export function routingMayContinue(receptionState: string): boolean {
  return ROUTING_ALLOWED_STATES.includes(receptionState);
}

export type RoutingStopDecision =
  /** 続けてよい。 */
  | { readonly kind: 'continue' }
  /** 止める。相関を確定させ、新しい hop を撃たない。 */
  | { readonly kind: 'stop'; readonly reason: RoutingStopReason };

/**
 * 受付の現状から、取次を続けてよいかを決める。
 *
 * `receptionState` が読めなかった（`undefined`）ときも**止める**。
 * 🔴 **不在から「まだ呼び出し中だ」をでっち上げない** ── 読めないまま撃つと、
 * 取り消された受付のために社内の電話が鳴る。
 */
export function decideRoutingStop(
  receptionState: string | undefined,
  requested?: RoutingStopReason,
): RoutingStopDecision {
  if (requested !== undefined) return { kind: 'stop', reason: requested };
  if (receptionState === undefined) return { kind: 'stop', reason: 'reception_terminal' };
  return routingMayContinue(receptionState)
    ? { kind: 'continue' }
    : { kind: 'stop', reason: 'reception_terminal' };
}
