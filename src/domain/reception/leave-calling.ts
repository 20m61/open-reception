/**
 * 呼び出し中を来訪者自身が抜けたことを、サーバへ伝えるべきか (#743)。
 *
 * ## なぜ要るのか
 *
 * `/give-up`（#743 AC3）が拾うのは**ポーリング上限に達した諦め**だけだった。
 * 来訪者が逃げ道バーの「最初に戻る」やチャットの「キャンセル」で自分から抜けた場合、
 * 端末は待機画面へ戻るのに**サーバの受付は `calling` のまま**残る。すると
 * `decideRoutingStop` は「進んでよい」と答え続け、**取次は hop 上限まで進み、
 * 社内の電話は鳴り続ける** ── #743 が塞いだのとまったく同じ「無人の呼び出し」。
 *
 * しかもポーリングは抜けた時点で止まる（#652）ので、**`/give-up` も呼ばれない**。
 * つまり自分から抜けるほうが、放っておくより取次が長く走る。
 *
 * ## なぜ純関数に切り出すのか
 *
 * 判断する場所が 2 つある（逃げ道バーと チャットドロワー）。片方に書くと、
 * **もう片方や 3 つ目の入口を足したときに黙って漏れる** ── このリポジトリが
 * 「逃げ道バーを画面分岐の外へ出した」(#455) のと同じ理由。
 */
import type { ReceptionState } from './state';

/** 来訪者が自分で受付をやめる操作。状態機械イベントの部分集合。 */
export type VisitorExitEvent = 'RESET' | 'CANCEL';

/**
 * サーバへキャンセルを伝えるべきか。
 *
 * 🔴 **`calling` のときだけ。** 他の状態では取次が走っていないので、要求を出しても
 * 意味が無いうえ、既に終端した受付（担当者が応答した直後など）を蒸し返す余地を作る。
 * 終端の受付を触らない契約はサーバ側にもあるが（`cancelReception` は状態機械に従う）、
 * **端末からも撃たない**ほうが、担当者が出た直後の窓が狭くなる。
 */
export function shouldCancelOnServer(
  state: ReceptionState,
  event: VisitorExitEvent,
  receptionId: string | undefined,
): boolean {
  if (state !== 'calling') return false;
  // 受付 id が無い＝サーバ側に受付がまだ無い（作成前）。伝える相手が居ない。
  return typeof receptionId === 'string' && receptionId.length > 0;
}

/**
 * 状態機械イベントのうち「来訪者が自分でやめた」もの。
 *
 * 🔴 **`BACK` を含めない。** 1 ステップ戻るのは受付をやめることではない
 * （そもそも `calling` から `BACK` は不正遷移で、状態機械が弾く）。
 */
export function isVisitorExit(eventType: string): eventType is VisitorExitEvent {
  return eventType === 'RESET' || eventType === 'CANCEL';
}
