import { DemoStudio } from '@/components/admin/demo-studio/DemoStudio';
import { defaultAdminTenantId } from '@/lib/admin/guard';
import { resolveAdminActor } from '@/lib/auth/actor';
import { canAccessTenant } from '@/domain/tenant/authorization';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 受付体験スタジオ Demo Harness (issue #363 Increment 1〜3)。
 * 認可は AdminLayout（resolveAdminActor + canEnterArea）とデモ実行/公開/共有 API（各 route の
 * requireActor + assertCanRead/assertCanWrite）が最終的に担う。本ページはシナリオ選択・
 * sandbox プレビュー起動・公開/共有パネルの配線に加え、**表示側の抑止**用に actor の書込可否
 * （`canWrite`）と単一テナント MVP の siteId（= defaultAdminTenantId、issue #363 Inc3 の公開先
 * 検証と同じスコープ）を DemoStudio へ渡す。viewer が操作ボタンを押しても API 側で 403 になる
 * （`rules/admin-api-authz.md`）前提だが、押せる UI を出さないことで誤操作の手間を減らす。
 */
export default async function AdminDemoPage() {
  const actor = await resolveAdminActor();
  const tenantId = defaultAdminTenantId();
  const canWrite = actor ? canAccessTenant(actor, tenantId, 'write') : false;
  return <DemoStudio canWrite={canWrite} siteId={String(tenantId)} />;
}
