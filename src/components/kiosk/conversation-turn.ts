/**
 * 会話ターン契約（`src/domain/reception/ui-contract.ts`）の表示解決 (#422 inc5-b)。
 *
 * 役割分担は逃げ道（`quick-actions.ts`）と同じ:
 * **どのターンで何を言うかの判断は契約が唯一の権威**で、ここは「意味論キー → その locale の
 * 文言」を解決するだけを持つ。契約は i18n に依存しない（domain は `lib/i18n` を知らない）ため、
 * 解決は component 層のこのモジュールが担う。
 *
 * なぜ要るか: 契約の `messageKeyForState` と画面の見出しの対応は、これまで
 * `ui-contract.test.ts` の中にしか存在しなかった。**本番コードに経路が無いまま「一致して
 * いる」ことだけを検証している状態**で、契約側だけ直しても画面は別の i18n キーを引き続ける。
 * 消費者ゼロの契約が静かに腐る形そのものなので、対応を本番経路へ出す。
 */
import {
  messageKeyForState,
  type MessageKey as TurnMessageKey,
  type ReceptionState,
} from '@/domain/reception/ui-contract';
import { makeT, type Locale, type MessageKey as I18nMessageKey } from '@/lib/i18n';

/**
 * ターンの意味論キー → 画面の主指示（`<h1 className="screen__title">`）の i18n キー。
 *
 * 主指示を持つのは選択・入力・確認の 5 画面だけ。結果系（呼び出し中/完了/失敗/未応答/
 * 代替/中止）の文言は `ResultPanel` の message が担い、`{target}` の差し込みを含むため
 * 契約の静的文言とは対応づかない（#487 で確認済み）。
 */
const TURN_MESSAGE_I18N_KEY: Partial<Record<TurnMessageKey, I18nMessageKey>> = {
  welcome: 'reception.purposePrompt',
  choosePurpose: 'reception.purposeDetailPrompt',
  chooseTarget: 'reception.targetPrompt',
  enterVisitorInfo: 'reception.visitorInfoPrompt',
  reviewAndConfirm: 'reception.confirm',
};

/** 主指示（screen__title）を持つ画面。空の見出しを生やさないため、無い側も明示する。 */
export const STATES_WITH_SCREEN_TITLE: ReadonlySet<ReceptionState> = new Set<ReceptionState>([
  'idle',
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
]);

/**
 * その画面の主指示を locale 解決して返す。主指示を持たない画面は `null`。
 *
 * 画面側は自分の i18n キーを直に引かず、必ず契約の `messageKeyForState` 経由でここを通す
 * （契約と表示で見出しを二重管理しない）。
 */
export function screenTitleFor(state: ReceptionState, locale: Locale): string | null {
  const key = TURN_MESSAGE_I18N_KEY[messageKeyForState(state)];
  return key === undefined ? null : makeT(locale)(key);
}
