'use client';

import { htmlLangFor, makeT, type Locale, type MessageKey } from '@/lib/i18n';
import { persistentRegionProps, type PersistentElementTestId } from './persistent-regions';

/**
 * 常設逃げ道バー (issue #121 / #325 / #361 AC2)。
 *
 * 受付（`KioskFlow`）と QR 受付（`CheckinFlow`）が**同じコンポーネント**を使う。かつて QR 側は
 * 各画面が後退ボタンを手書きしており、後退の位置と語彙が受付と違っていた。バーを 2 つ実装すると
 * 片方だけ直る（このリポジトリが繰り返し踏んできた形）ので、構造そのものを 1 つにする。
 *
 * **出す項目を決めるのはここではない。** 受付は `escapeHatchesFor`、QR は `checkinEscapesFor`
 * が契約から導出した結果を渡す。ここは描画だけを持つ（項目ゼロなら何も描かない）。
 *
 * 常設バーなので訳が抜けると来訪者が受付中ずっと日本語のボタンを見続ける (#327)。文言は
 * 必ず i18n キーで受け取り、解決はここで行う。
 */
export type EscapeBarItem = {
  /** React key と `onSelect` の識別子。受付は `ReceptionAction`、QR は `CheckinEvent`。 */
  id: string;
  labelKey: MessageKey;
  variant: 'ghost' | 'secondary';
  testId: string;
};

export function EscapeBar({
  items,
  onSelect,
  regionTestId,
  locale,
  barRef,
}: {
  items: ReadonlyArray<EscapeBarItem>;
  onSelect: (id: string) => void;
  /** 登録簿の常設要素 ID。領域属性は登録簿からしか供給されない（描画側で手書きしない）。 */
  regionTestId: PersistentElementTestId;
  locale: Locale;
  barRef?: React.Ref<HTMLElement>;
}) {
  if (items.length === 0) return null;
  const tr = makeT(locale);
  return (
    <nav
      ref={barRef}
      className="kiosk-escape-bar"
      {...persistentRegionProps(regionTestId)}
      aria-label={tr('reception.escapeBarLabel')}
      lang={htmlLangFor(locale)}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`btn btn--${item.variant}`}
          data-testid={item.testId}
          onClick={() => onSelect(item.id)}
        >
          {tr(item.labelKey)}
        </button>
      ))}
    </nav>
  );
}
