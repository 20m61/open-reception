/**
 * 管理画面 共有 UI プリミティブ バレル (issue #92, increment 1)。
 *
 * 既存の重複しがちな UI（dashboard/usage/integrations 等に散在）を将来寄せる先。
 * 本増分では **新設のみ**。既存コンポーネントの移行は #92 increment 2 で行う
 * （詳細は docs/component-catalog.md の移行対応表）。
 */
export * from './tokens';
export { Button, buttonStyle, type ButtonVariant } from './Button';
export { Card, MetricCard, CardGrid } from './Card';
export { Section } from './Section';
export { StatusBadge } from './StatusBadge';
export { DataTable, type Column } from './DataTable';
export { Field, FormRow } from './Field';
export { SecretStatusField } from './SecretStatusField';
export { DangerZone } from './DangerZone';
export { EmptyState } from './EmptyState';
export { Skeleton, SkeletonBlock } from './Skeleton';
