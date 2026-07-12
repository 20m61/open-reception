import type { CSSProperties } from 'react';
import { font } from './ui/tokens';

/**
 * 管理ナビ 1 項目の見た目（active / pending）を 1 箇所で決める純関数 (issue #94, increment 1)。
 *
 * SPA ライク化では「クリックした瞬間にアクティブ表示が即時反映され、遷移中はその項目が
 * 読み込み中だと分かる」ことが重要。見た目決定を React から切り出してユニットテスト可能にする。
 * DOM/フックには依存しない（pending は呼び出し側が useLinkStatus 等から渡す）。
 *
 * サイドバー語中改行の解消 (issue #330 item4): サイドバーは 240px 固定（globals.css
 * `.admin-shell__sidebar`）。ナビ項目はページ本文の巨大な受付端末向けフォント
 * （`--font-body` = 20px）をそのまま継承していたため、"受付端末（拠点別）" のような長い
 * ラベルが 1 行に収まらず語の途中で折り返っていた。管理画面の他コンポーネントと揃えた
 * 密度（`ui/tokens.font.body` = 0.95rem）に縮めるだけで大半のラベルは 1 行に収まる。
 * 加えて `word-break: keep-all` で単語（カッコ書きの単位）の途中では折らないようにし、
 * 万一それでも収まらない極端に長いラベルが来た場合の保険として `overflow-wrap: anywhere`
 * を最後の手段として効かせる（自然な折り返しが可能な限りそちらを優先し、最後の手段でのみ
 * 強制的に折る＝サイドバーからの横あふれは起きない）。
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
    fontSize: font.body,
    lineHeight: 1.3,
    wordBreak: 'keep-all',
    overflowWrap: 'anywhere',
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
