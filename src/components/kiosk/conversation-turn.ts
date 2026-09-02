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
  checkinMessageKeyFor,
  conversationTurnFor,
  messageKeyForState,
  type CheckinMessageKey,
  type MessageKey as TurnMessageKey,
  type ReceptionAction,
  type ReceptionState,
  type TurnContext,
} from '@/domain/reception/ui-contract';
import type { CheckinState } from '@/domain/checkin/state';
import { RECEPTION_PURPOSES, type ReceptionPurposeId } from '@/domain/reception/session';
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

/**
 * QR 受付の字幕の意味論キー → i18n キー。**全 `CheckinMessageKey` を網羅する**（Record なので
 * 契約にキーが増えたら型で落ちる）。
 *
 * なぜ要るか: `CheckinShell` は見出し・リードを `makeT(locale)` で訳していたのに、アバター
 * 字幕だけ契約の ja 既定文言（`CHECKIN_MESSAGE_TEXT_JA`）をそのまま渡していた。English を
 * 選んだ来訪者は、英語の見出しの隣で日本語の字幕を読むことになる。#361 AC「QR 受付が独立
 * した別 UI に見えず、同じ受付体験として進行する」に対して、言語がそこだけ切れていた。
 */
const CHECKIN_MESSAGE_I18N_KEY: Record<CheckinMessageKey, I18nMessageKey> = {
  intro: 'checkin.subtitle.intro',
  chooseMethod: 'checkin.subtitle.chooseMethod',
  cameraPermission: 'checkin.subtitle.cameraPermission',
  scanning: 'checkin.subtitle.scanning',
  resolving: 'checkin.subtitle.resolving',
  reviewReservation: 'checkin.subtitle.reviewReservation',
  calling: 'checkin.subtitle.calling',
  completed: 'checkin.subtitle.completed',
  cancelled: 'checkin.subtitle.cancelled',
  manualFallback: 'checkin.subtitle.manualFallback',
  cameraError: 'checkin.subtitle.cameraError',
  scanError: 'checkin.subtitle.scanError',
  expiredError: 'checkin.subtitle.expiredError',
  usedError: 'checkin.subtitle.usedError',
  revokedError: 'checkin.subtitle.revokedError',
  networkError: 'checkin.subtitle.networkError',
};

/**
 * QR 受付の字幕を locale 解決して返す。
 *
 * 受付側の `screenTitleFor` と同じ役割分担: **どの局面で何を言うかは契約が決め**、ここは
 * 「意味論キー → その locale の文言」を解決するだけ。`CheckinShell` はこの値を
 * `checkinConversationTurnFor(state, { message: { displayText } })` へ注入する。
 */
export function checkinSubtitleFor(state: CheckinState, locale: Locale): string {
  return makeT(locale)(CHECKIN_MESSAGE_I18N_KEY[checkinMessageKeyFor(state)]);
}

/** 表示用に解決した回答候補。ラベルは locale 適用済み、`testId` は既存 e2e との後方互換。 */
export type TurnAnswerView = {
  id: string;
  label: string;
  intent: ReceptionAction;
  testId: string;
  /** 目的選択を省いて先に確定する用件（待機の入口カードのみ）。 */
  presetPurpose?: ReceptionPurposeId;
};

/** 表示用に解決した引き渡し入口（QR 受付）。状態機械は進めない。 */
export type TurnHandoffView = {
  id: string;
  label: string;
  to: 'checkin';
  testId: string;
};

const HANDOFF_DISPLAY: Record<string, AnswerDisplay> = {
  checkin: { i18nKey: 'kiosk.action.checkin.label', testId: 'start-checkin' },
};

/**
 * そのターンの引き渡し入口を locale 解決して返す。
 *
 * 回答（`turnAnswersFor`）とは別に取る。**押したときに起こることが違う**（回答は状態機械の
 * イベントを起こし、引き渡しは別シェルへ切り替える）ので、画面が取り違えられない形にする。
 */
export function turnHandoffsFor(
  state: ReceptionState,
  locale: Locale,
): ReadonlyArray<TurnHandoffView> {
  const tr = makeT(locale);
  const views: TurnHandoffView[] = [];
  for (const handoff of conversationTurnFor(state).handoffs) {
    const display = HANDOFF_DISPLAY[handoff.id];
    if (display === undefined) continue;
    views.push({ id: handoff.id, label: tr(display.i18nKey), to: handoff.to, testId: display.testId });
  }
  return views;
}

type AnswerDisplay = { i18nKey: I18nMessageKey; testId: string };

/**
 * 契約の回答 → 表示（i18n キーと testId）。**ターンごとに引く。**
 *
 * 同じ id が別のターンでは別物を意味する。待機の `delivery`（用件を先取りして担当者選択へ
 * 直行する入口）と、用件選択の `delivery`（用件そのものの選択）は違う質問への回答で、
 * ラベルも testId も別。id だけで引くと片方が他方に化ける。
 *
 * 強調度（primary/secondary）は含めない。**どの回答を出すかは契約が決め、どう見せるかは
 * 画面が決める**という役割分担（`quick-actions.ts` の EscapeHatch と同じ）。
 */
const ANSWER_DISPLAY: Partial<Record<ReceptionState, Record<string, AnswerDisplay>>> = {
  // 待機の入口カード (#422 inc5-b 増分 3b)。testId は既存 e2e との後方互換を保つ
  // （`callStaff` だけ歴史的に `start-reception`）。
  idle: {
    callStaff: { i18nKey: 'kiosk.action.callStaff.label', testId: 'start-reception' },
    department: { i18nKey: 'kiosk.action.department.label', testId: 'quick-department' },
    delivery: { i18nKey: 'kiosk.action.delivery.label', testId: 'quick-delivery' },
    other: { i18nKey: 'kiosk.action.other.label', testId: 'quick-other' },
  },
  // 用件カード (#422 inc5-b 増分 3a)。契約の `RECEPTION_PURPOSES.label` は生の日本語
  // リテラルで、画面は辞書を引いていた（ja では一致していたが**同じ文言の二重管理**で、
  // 辞書だけ直すとズレる）。表示は辞書を正とする。
  selectingPurpose: Object.fromEntries(
    RECEPTION_PURPOSES.map((purpose) => [
      purpose.id,
      {
        i18nKey: `reception.purpose.${purpose.id}` as I18nMessageKey,
        testId: `purpose-${purpose.id}`,
      },
    ]),
  ),
  confirming: { confirm: { i18nKey: 'reception.callWithThis', testId: 'confirm-call' } },
  connected: { complete: { i18nKey: 'reception.finishReception', testId: 'complete' } },
  failed: { fallback: { i18nKey: 'reception.altContact', testId: 'use-fallback' } },
  timeout: { fallback: { i18nKey: 'reception.altContact', testId: 'use-fallback' } },
};

/**
 * そのターンで提示する回答候補を locale 解決して返す。
 *
 * **出すか出さないかの判断はここに持たない。** 契約 `conversationTurnFor` が返した回答を
 * 表示へ写すだけ。とくに「通信断では代替導線を出さない」判断（`shouldOfferAlternativeContact`）
 * は契約側に在り、`context.callFailureReason` を渡すことで効く。**渡し忘れると、通信が
 * 切れている端末に「代表窓口へお繋ぎします」という果たせない約束の CTA が出る。**
 */
export function turnAnswersFor(
  state: ReceptionState,
  locale: Locale,
  context?: TurnContext,
): ReadonlyArray<TurnAnswerView> {
  const tr = makeT(locale);
  const displays = ANSWER_DISPLAY[state] ?? {};
  const views: TurnAnswerView[] = [];
  for (const answer of conversationTurnFor(state, context).answers) {
    const display = displays[answer.id];
    if (display === undefined) continue;
    views.push({
      id: answer.id,
      label: tr(display.i18nKey),
      intent: answer.intent,
      testId: display.testId,
      ...(answer.presetPurpose === undefined ? {} : { presetPurpose: answer.presetPurpose }),
    });
  }
  return views;
}
