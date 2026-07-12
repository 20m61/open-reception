import type { ReactNode } from 'react';
import type { QuickActionIntent } from './quick-actions';
import type { ReceptionPurposeId } from '@/domain/reception/session';

/**
 * クイックアクションのラインアイコン (#119 UX, モダン受付のスキャン性向上)。
 * currentColor の stroke ベースで、CTA カード上でアクセント色に着色して表示する。
 * 装飾なので描画側で aria-hidden を付ける（ラベルは別途テキストで提供）。
 */

const svgProps = {
  width: 48,
  height: 48,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICONS: Record<QuickActionIntent, ReactNode> = {
  // 担当者を呼ぶ：ヘッドセット（受付スタッフ対応）
  callStaff: (
    <svg {...svgProps} aria-hidden="true">
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <rect x="2.5" y="13" width="4" height="6" rx="1.4" />
      <rect x="17.5" y="13" width="4" height="6" rx="1.4" />
      <path d="M19.5 19v.5a3 3 0 0 1-3 3H13" />
    </svg>
  ),
  // QR で受付：QR コード
  checkin: (
    <svg {...svgProps} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <path d="M14 14h3v3M21 14v.01M14 21h.01M21 17.5V21h-3.5" />
    </svg>
  ),
  // 部署から選ぶ：建物
  department: (
    <svg {...svgProps} aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="1.4" />
      <path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M10.5 21v-3.5h3V21" />
    </svg>
  ),
  // 配送・納品：荷物
  delivery: (
    <svg {...svgProps} aria-hidden="true">
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  ),
  // その他：3 点
  other: (
    <svg {...svgProps} aria-hidden="true">
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export function quickActionIcon(intent: QuickActionIntent): ReactNode {
  return ICONS[intent] ?? null;
}

/**
 * 目的選択カードのラインアイコン (#324-3, 視覚語彙の統一)。
 * 待機カード（`quickActionIcon`）と同じ svgProps・stroke 語彙で、目的選択カードにも
 * アイコンを添えて「無装飾ラベルだけ」の不整合を解消する。装飾なので描画側で aria-hidden を付ける。
 */
const PURPOSE_ICONS: Record<ReceptionPurposeId, ReactNode> = {
  // 面会：来訪者と担当者（人物二人）
  meeting: (
    <svg {...svgProps} aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <circle cx="16.5" cy="9" r="2.5" />
      <path d="M3 20v-1a5 5 0 0 1 10 0v1M14 20v-.5a4.5 4.5 0 0 1 7-3.7" />
    </svg>
  ),
  // 納品：荷物（待機の delivery と同じ語彙で統一）
  delivery: (
    <svg {...svgProps} aria-hidden="true">
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  ),
  // 打ち合わせ：会話の吹き出し
  interview: (
    <svg {...svgProps} aria-hidden="true">
      <path d="M4 5h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M7 9h7M7 12h4" />
    </svg>
  ),
  // その他：3 点（待機の other と同じ語彙で統一）
  other: (
    <svg {...svgProps} aria-hidden="true">
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export function purposeIcon(id: ReceptionPurposeId): ReactNode {
  return PURPOSE_ICONS[id] ?? null;
}
