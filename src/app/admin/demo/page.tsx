import { DemoStudio } from '@/components/admin/demo-studio/DemoStudio';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 受付体験スタジオ Demo Harness (issue #363 Increment 1)。
 * 認可は AdminLayout（resolveAdminActor + canEnterArea）とデモ実行 API（requireActor +
 * assertCanWrite）が担う。本ページはシナリオ選択と sandbox プレビュー起動の配線のみ。
 */
export default function AdminDemoPage() {
  return <DemoStudio />;
}
