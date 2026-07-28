'use client';

import { DEFAULT_LOCALE, htmlLangFor, makeT, type Locale } from '@/lib/i18n';
import type { KioskFlow } from './types';

/**
 * 目的選択（受付端末・カスタムフロー） (issue #100, increment 1)。
 *
 * /api/kiosk/flow が返す有効フローを大きなボタンで一覧表示し、来訪者が目的を選ぶ。
 * iPad で押しやすいよう大きめのタップ領域にする（issue #100 UX 方針）。スタンドアロン:
 * 選択結果は onSelect で呼び出し元へ渡す（KioskFlow への組み込みは後段で配線）。
 *
 * 画面の固定文言は i18n カタログ経由 (#327)。フロー名・説明はテナントが管理画面で入力した
 * 値なので翻訳しない（入力された言語のまま出す）。
 */
export function PurposeSelector({
  flows,
  onSelect,
  locale = DEFAULT_LOCALE,
}: {
  flows: readonly KioskFlow[];
  onSelect: (flow: KioskFlow) => void;
  locale?: Locale;
}) {
  const tr = makeT(locale);
  if (flows.length === 0) {
    return (
      <p data-testid="purpose-empty" lang={htmlLangFor(locale)} style={{ opacity: 0.7 }}>
        {tr('customFlow.noFlows')}
      </p>
    );
  }
  return (
    <div data-testid="purpose-selector" lang={htmlLangFor(locale)} style={{ display: 'grid', gap: 16 }}>
      <h2 style={{ margin: 0 }}>{tr('reception.purposePrompt')}</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {flows.map((flow) => (
          <button
            key={flow.id}
            type="button"
            data-testid="purpose-option"
            data-purpose={flow.purposeKey}
            onClick={() => onSelect(flow)}
            style={optionStyle}
          >
            <span style={{ fontSize: '1.2rem', fontWeight: 700 }}>{flow.displayName}</span>
            {flow.description ? (
              <span style={{ fontSize: '0.95rem', opacity: 0.8 }}>{flow.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

const optionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minHeight: 96,
  padding: 20,
  textAlign: 'left',
  borderRadius: 16,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
