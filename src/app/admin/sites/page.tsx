import { SitesManager } from '@/components/admin/SitesManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 拠点管理 (issue #87)。 */
export default function AdminSitesPage() {
  return <SitesManager />;
}
