/**
 * 常設要素 → 領域の登録簿 (#422 inc5-c 増分 2)。
 *
 * 領域語彙（`guidance` / `answers` / `help`）は契約が持つ。ここが持つのは
 * **実 DOM 要素との対応**で、契約は言語切替やアクセシビリティメニューの存在を知らない
 * （知らせると domain が component へ依存する）。
 *
 * 目的は見た目を変えることではなく、**領域外の常設要素を後から足せなくすること**。
 * 常設要素は受付のどの局面でも視界に居座るので、増えるほど来訪者の注意が分散する。
 * 新しく常設するものを足すときは、ここへ登録して 3 領域のどれかに属させる。属せないなら
 * それは常設すべきものではない、という判断の足場にする。
 */
import { type PersistentRegion } from '@/domain/reception/ui-contract';

export type PersistentElement = {
  /** DOM 上の `data-testid`。要素の同定に使う。 */
  testId: string;
  region: PersistentRegion;
};

/**
 * 常設要素の一覧（表示順ではなく領域ごと）。
 *
 * 「常設」は**受付の複数局面にまたがって視界に残るもの**を指す。単一画面の内容
 * （用件カード・入力フォーム・結果パネル）は回答対象領域そのものなので個別に登録しない。
 * 無操作警告オーバーレイのような一時的な割込みも常設ではない。
 */
export const PERSISTENT_ELEMENTS: ReadonlyArray<PersistentElement> = [
  // --- 案内: 今どういう局面かを伝える ---
  // 受付状態を表情・モーション・字幕で伝える付き添い (#361)。操作はしない（pointer-events:none）。
  { testId: 'kiosk-avatar-companion', region: 'guidance' },
  // 音声対話の字幕・復唱確認 (#364)。聞き取り結果を目で確認させるための案内。
  { testId: 'voice-layer', region: 'guidance' },
  // --- ヘルプ: 行き詰まったときの手段 ---
  // 戻る/最初に戻るの唯一の後退導線。常時可視が設計意図 (#325)。
  { testId: 'kiosk-escape-bar', region: 'help' },
  // 検索 0 件などで行き詰まったときの相談口 (#122 / #322)。重要操作は確定できない。
  { testId: 'kiosk-chat-drawer', region: 'help' },
  // 文字サイズ・コントラスト・やさしい日本語の切替 (#321)。全画面で 1〜2 タップ。
  { testId: 'a11y-menu-button', region: 'help' },
  // 読めない言語で詰まらないための切替 (#103)。待機画面にのみ常設する。
  { testId: 'kiosk-language-switcher', region: 'help' },
  // 受付ではなく退館の用事で来た人の逃げ道 (#102)。待機画面にのみ小さく常設する。
  { testId: 'kiosk-checkout-link', region: 'help' },
];

const REGION_BY_TEST_ID: ReadonlyMap<string, PersistentRegion> = new Map(
  PERSISTENT_ELEMENTS.map((element) => [element.testId, element.region]),
);

/**
 * その常設要素がどの領域に属するか。未登録なら `null`。
 *
 * **推測で領域を与えない。** 未登録の要素に既定領域を与えると、登録簿を通さずに常設要素を
 * 増やせてしまい、この増分の目的（領域外を作らせない）が失われる。
 */
export function regionOfElement(testId: string): PersistentRegion | null {
  return REGION_BY_TEST_ID.get(testId) ?? null;
}

/** 登録済み常設要素の testId（この型に無い値は描画側で使えない）。 */
export type PersistentElementTestId = (typeof PERSISTENT_ELEMENTS)[number]['testId'];

/**
 * 常設要素に付ける DOM 属性（`data-testid` と `data-persistent-region`）。
 *
 * **testId と領域を必ず同じ場所から供給する。** 描画側が `data-testid` を手書きすると、
 * 登録簿に無い常設要素が生えても誰も気づかない。ここを通せば、登録していない要素は
 * 領域属性を持てず、e2e の突き合わせで落ちる。
 */
export function persistentRegionProps(testId: PersistentElementTestId): {
  'data-testid': string;
  'data-persistent-region': PersistentRegion;
} {
  const region = REGION_BY_TEST_ID.get(testId);
  if (region === undefined) {
    // 型で防いでいるが、型を迂回した呼び出しに黙って既定値を与えない。
    // メッセージは開発者向けなので ASCII（kiosk 配下は生 CJK リテラル禁止・#327）。
    throw new Error(`unregistered persistent element: ${testId}`);
  }
  return { 'data-testid': testId, 'data-persistent-region': region };
}
