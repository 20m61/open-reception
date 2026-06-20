'use client';

import { useState } from 'react';
import { PurposeSelector } from './PurposeSelector';
import { VisitorInfoForm } from './VisitorInfoForm';
import type { FlowFieldValues, KioskFlow } from './types';

/**
 * カスタムフローレンダラ（スタンドアロン） (issue #100, increment 1)。
 *
 * 目的選択 → 来訪者情報入力（フロー定義の fields から動的生成）までを 1 コンポーネントで
 * 描画する自己完結部品。**KioskFlow.tsx には組み込まない**（統合は後段でオーケストレータが
 * 配線）。確認・呼び出しステップは既存 KioskFlow の責務のため本部品では扱わず、入力完了を
 * onComplete(flow, values) で呼び出し元へ渡す。目的選択を間違えた場合は入力画面から戻れる。
 *
 * 想定統合（次増分）:
 *   - KioskFlow の selectingPurpose で本部品の PurposeSelector を使い、選択フローを保持。
 *   - inputVisitorInfo で VisitorInfoForm を描画し、onComplete の values を VisitorInfo に
 *     写して SUBMIT_VISITOR_INFO を発火。confirm/call は既存の状態機械に委ねる。
 */
export function CustomFlowRenderer({
  flows,
  onComplete,
}: {
  flows: readonly KioskFlow[];
  onComplete: (flow: KioskFlow, values: FlowFieldValues) => void;
}) {
  const [selected, setSelected] = useState<KioskFlow | null>(null);

  if (!selected) {
    return <PurposeSelector flows={flows} onSelect={setSelected} />;
  }

  // 目的に visitorInfo ステップが無ければ、入力なしでそのまま完了させる。
  if (!selected.steps.includes('visitorInfo') || selected.fields.length === 0) {
    return (
      <div data-testid="custom-flow-no-input" style={{ display: 'grid', gap: 16 }}>
        <h2 style={{ margin: 0 }}>{selected.displayName}</h2>
        {selected.description ? <p style={{ opacity: 0.8, margin: 0 }}>{selected.description}</p> : null}
        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" onClick={() => setSelected(null)} style={secondaryBtn}>
            戻る
          </button>
          <button
            type="button"
            data-testid="custom-flow-proceed"
            onClick={() => onComplete(selected, {})}
            style={primaryBtn}
          >
            確認へ進む
          </button>
        </div>
      </div>
    );
  }

  return (
    <VisitorInfoForm
      fields={selected.fields}
      onBack={() => setSelected(null)}
      onSubmit={(values) => onComplete(selected, values)}
    />
  );
}

const primaryBtn: React.CSSProperties = {
  minHeight: 52,
  padding: '12px 24px',
  borderRadius: 12,
  border: 'none',
  background: 'var(--color-accent)',
  color: '#0f172a',
  fontWeight: 700,
  fontSize: '1.05rem',
  cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  minHeight: 52,
  padding: '12px 24px',
  borderRadius: 12,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontSize: '1.05rem',
  cursor: 'pointer',
};
