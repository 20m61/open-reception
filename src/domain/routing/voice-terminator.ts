/**
 * 鳴っている provider 通話を切る境界 (#743 AC2 後半)。
 *
 * ## なぜ発信と別契約なのか
 *
 * `VoiceCallInitiator`（`./voice-initiator.ts`）は「1 手を撃つ」契約で、成功すると
 * **新しい相関が生まれる**。切断はその逆で、**既にある通話 ID を消しに行くだけ**。
 * 同じ interface に押し込むと、呼び出し側が「撃つつもりで切る」形を書けてしまう。
 *
 * ## 切断は best-effort
 *
 * 🔴 **切断の失敗で受付側の停止を巻き戻さない。** 取次を止める判断（`./stop.ts`）は
 * 既に済んでおり、切断はその後始末でしかない。失敗したら呼出予算（`dialExpiresAt`）が
 * 経過して通話は自然に終わる ── #743 の「切らない」案がもともと許容していた状態へ戻るだけで、
 * **悪化しない**。
 *
 * ## 冪等
 *
 * 🔴 **もう存在しない通話への切断要求を失敗にしない。** webhook の再配信・端末の再試行で
 * 二度呼ばれるのは普通で、そのたびに「失敗」を記録すると本物の失敗が埋もれる。
 */

/** 切断要求の結果。**呼び出し側はこれで分岐せず、記録だけに使ってよい**（best-effort）。 */
export type VoiceTerminationOutcome =
  /** 切断要求が通った。 */
  | { readonly kind: 'terminated' }
  /** 対象の通話がもう無い（既に切れている）。冪等なので成功と同じ扱い。 */
  | { readonly kind: 'already_ended' }
  /** 実発信経路ではない（テナント未設定・資格情報不備）。切るべき通話がそもそも無い。 */
  | { readonly kind: 'not_wired' }
  /** 要求が通らなかった。呼出予算での自然終了に委ねる。 */
  | { readonly kind: 'failed' };

/**
 * provider の応答ステータスを結果へ写す。
 *
 * 🔴 **404 を失敗にしない。** 「もう無い」は切断の目的が達成された状態であって、
 * 異常ではない（上の「冪等」参照）。
 *
 * 🔴 **2xx 以外を成功にしない。** とくに 401/403（資格情報の失効）を握り潰すと、
 * 「切ったつもりで鳴り続けている」状態が記録上は成功として残る。
 */
export function terminationOutcomeFromStatus(status: number): VoiceTerminationOutcome {
  if (status === 404) return { kind: 'already_ended' };
  return status >= 200 && status < 300 ? { kind: 'terminated' } : { kind: 'failed' };
}

/**
 * 鳴っている通話を切る境界。**1 通話ぶんの切断要求を出すだけ**で、結果の確定
 * （`completed` イベント）は従来どおり webhook で届く。
 */
export interface VoiceCallTerminator {
  /** Provider 識別子。`VoiceCallInitiator.key` と揃える。 */
  readonly key: string;
  terminate(providerCallId: string): Promise<VoiceTerminationOutcome>;
}
