/**
 * 既定の音声認識が「擬似」か「実物」かの宣言 (#872)。
 *
 * ## なぜ要るか
 *
 * `/admin/voice` の「音声認識を有効にする」は、運用者が本番テナントで入れられる。しかし
 * 既定の STT は `MockSttAdapter` で、**マイクを一切使わず在席担当者名の先頭 3 件を返す**。
 * 来訪者には「聞き取り中…」の後に「認識した候補です」と提示される —— 何も聞かれていないのに、
 * 聞き取られたと信じる。
 *
 * 問題は mock そのものではない。interface + mock 先行は本プロジェクトの型で、実 STT は
 * #370 が #65（実機・実資格情報）にスタックしている。問題は **mock だと分からないまま
 * 本番でトグルできること**である。管理画面のラベルはむしろ「結果は候補表示・確認必須」と
 * 安心させる方向にだけ書かれていた。
 *
 * ## なぜ宣言を手で持つのか
 *
 * 実 provider が注入されるのは `KioskFlow` 層（`sttAdapterFactory` prop）で、管理画面からは
 * 見えない。サーバ設定にも現れない。したがって「実物が居るか」を admin が実行時に知る術は
 * 今のところ無い。
 *
 * 代わりに**宣言を実体へテストで縛る**（`stt-capability.test.ts`）。既定ファクトリが
 * `MockSttAdapter` を返す限り宣言は `'mock'` でなければ落ち、#370 が既定を実 provider へ
 * 変えれば今度は `'mock'` のままだと落ちる。**どちらを触っても、もう一方を直すまで通らない。**
 * 散文の申し送りではなく、機械が止める。
 */

/** 既定の音声認識の実体。 */
export type SttCapability = 'mock' | 'real';

/**
 * 現在の既定 STT。
 *
 * 🔴 **手で書き換えないこと。** 既定ファクトリ（`components/kiosk/stt-adapter.ts` の
 * `defaultSttAdapterFactory`）の実体と一致していなければ `stt-capability.test.ts` が落ちる。
 * 実 provider を既定にする増分（#370）で、ファクトリと同時にここを `'real'` へ変える。
 */
export const DEFAULT_STT_CAPABILITY: SttCapability = 'mock';

/**
 * 来訪者へ出る音声認識が擬似か。
 *
 * 呼び出し側（管理画面）が `instanceof MockSttAdapter` を書かずに済むようにする。
 * 判定の根拠を 1 箇所へ集め、admin が kiosk の内部実装へ依存しないため。
 */
export function isSttRecognitionSimulated(): boolean {
  return DEFAULT_STT_CAPABILITY === 'mock';
}
