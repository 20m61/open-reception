/**
 * `calling` をどの媒体で待つかの判定 (#4 Inc D-2 項目 2)。
 *
 * ## なぜ判定が要るようになったか
 *
 * `'calling'` はもともと **Vonage Video** 専用の意味だった ── 「セッションを確立したので
 * 担当者の参加を待っている」。実 PSTN 発信を配線したことで、**セッションを持たない
 * `'calling'`**（電話を鳴らして webhook を待っている）が生まれた。
 *
 * 見分けずにビデオビューを開くと、**存在しないセッションのトークンを取りに行って失敗する**。
 * 逆に「calling なら必ず PSTN」にすると既存のビデオ受付が壊れる。判定材料はセッション ID の
 * 有無しかないので、そこを 1 つの純関数に閉じる（JSX の中で `?.` を重ねない）。
 */

export type CallMediumInput = {
  readonly state: string;
  /** Vonage Video のセッション ID。**PSTN 発信では付かない**。 */
  readonly vonageSessionId?: string | null;
};

/**
 * ビデオビューを開くべきか。
 *
 * 🔴 **空文字・空白は「セッションがある」ではない。** `?? ''` を経由した値が「設定済み」に
 * 化けると、セッションの無い受付でビデオビューが開く（本リポジトリが繰り返し踏んだ形）。
 */
export function shouldOpenVideoView(input: CallMediumInput): boolean {
  if (input.state !== 'calling') return false;
  const sessionId = input.vonageSessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}
