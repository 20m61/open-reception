import { OperatingHoursManager } from '@/components/admin/OperatingHoursManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 営業時間設定 (issue #367)。
 * テナント/サイトは既存 admin 慣例（`resolveDefaultScope`、env で上書き可能。
 * `src/app/admin/call-routing/page.tsx` と同方針）で解決して渡す。
 *
 * ナビ配線: `src/components/admin/navigation.ts`（他トラック占有・オーケストレータが後で配線）。
 * このページ自体は直接 URL（/admin/operating-hours）でアクセス可能。
 */
export default function AdminOperatingHoursPage() {
  const scope = resolveDefaultScope();
  return <OperatingHoursManager tenantId={String(scope.tenantId)} siteId={String(scope.siteId)} />;
}
