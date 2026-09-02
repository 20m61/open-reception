'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * 管理画面のモーダルに**フォーカス管理**を与える (#890 / 課題 15)。
 *
 * ## なぜ要るか
 *
 * `DevicesManager` の 2 つのオーバーレイは `role="dialog" aria-modal="true"` を**宣言しながら**、
 * autoFocus / focus trap / focus 復帰 / Escape の**いずれも持っていなかった**。キーボードや
 * 支援技術の利用者はダイアログの外へタブで出てしまい、背後の一覧を操作できてしまう。
 * しかもそこは **「再表示できない」受付 URL を表示する画面**である。
 *
 * `AdminShell` は同じ Escape をドロワーで実装済みだった —— **前例が在るのに写されていない**、
 * このリポジトリが繰り返している形（#870 / #884 / #886 に続く）。今回は共有フックにして、
 * 次のモーダルが同じ穴を開けられないようにする。
 *
 * ## 何をするか
 *
 * 1. 開いたら最初の操作要素へフォーカスを移す
 * 2. Tab / Shift+Tab をダイアログ内で循環させる（背後へ出さない）
 * 3. Escape で閉じる
 * 4. 閉じたら**開く前にフォーカスがあった要素へ戻す**
 *
 * 4 が抜けやすい。戻さないと、閉じた瞬間にフォーカスが `body` へ落ち、キーボード利用者は
 * 一覧の先頭から辿り直すことになる（#787 で kiosk 側が踏んだのと同じ型）。
 */
export function useModalDialog<T extends HTMLElement>({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  /** 開く直前にフォーカスがあった要素。閉じたらここへ返す。 */
  const restoreTo = useRef<HTMLElement | null>(null);

  /** ダイアログ内の、いまタブ移動できる要素。**毎回引き直す**（中身が動くため）。 */
  const focusables = useCallback((): HTMLElement[] => {
    const root = ref.current;
    if (!root) return [];
    const nodes = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    // `display: none` 等で実際には辿れないものを除く。offsetParent は position:fixed で
    // null になるので、矩形の有無で見る。
    return [...nodes].filter((el) => el.getClientRects().length > 0);
  }, []);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 最初の操作要素へ。無ければコンテナ自身（`tabIndex={-1}` を付けておく）。
    const first = focusables()[0] ?? ref.current;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        // 中に何も無いなら外へ出さない（背後を操作させない）。
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      // 端で折り返す。**ダイアログ外に居るときも引き戻す** —— 背後をクリックして
      // フォーカスが外れた状態から Tab した場合に、そのまま背後を辿れてしまうため。
      if (!ref.current?.contains(active)) {
        e.preventDefault();
        firstItem.focus();
        return;
      }
      if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      } else if (e.shiftKey && active === firstItem) {
        e.preventDefault();
        lastItem.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // 閉じたら開く前の要素へ返す。戻さないとフォーカスが body へ落ちる。
      restoreTo.current?.focus();
    };
  }, [open, onClose, focusables]);

  /*
    ref オブジェクトをそのまま返す。`{ ref }` で包むと呼び出し側が描画中に `.ref` を読むことになり、
    `react-hooks/refs`（描画中に ref へ触るな）が error を出す。返り値をそのまま
    `ref={...}` へ渡せる形が素直。
  */
  return ref;
}
