import type { CSSProperties } from 'react';

/**
 * 管理ナビ 1 項目の見た目（active / pending）を 1 箇所で決める純関数 (issue #94, increment 1)。
 *
 * SPA ライク化では「クリックした瞬間にアクティブ表示が即時反映され、遷移中はその項目が
 * 読み込み中だと分かる」ことが重要。見た目決定を React から切り出してユニットテスト可能にする。
 * DOM/フックには依存しない（pending は呼び出し側が useLinkStatus 等から渡す）。
 */
export function navLinkStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 8,
    textDecoration: 'none',
    color: 'var(--color-text)',
    opacity: active ? 1 : 0.8,
    background: active ? 'var(--color-surface-2)' : 'transparent',
    fontWeight: active ? 700 : 400,
    borderLeft: active ? '3px solid var(--color-accent)' : '3px solid transparent',
    // 遷移開始時の即時フィードバック（CSS で軽く）。
    transition: 'background 120ms ease, opacity 120ms ease',
  };
}

/**
 * 項目の `aria-current` 値。アクティブ時のみ 'page'、それ以外は undefined。
 * スクリーンリーダーに現在地を即時に伝える（SPA 遷移でも更新される）。
 */
export function navLinkAriaCurrent(active: boolean): 'page' | undefined {
  return active ? 'page' : undefined;
}
