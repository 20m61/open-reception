import { DepartmentsManager } from '@/components/admin/DepartmentsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 部署管理 (issue #25)。 */
export default function AdminDepartmentsPage() {
  return <DepartmentsManager />;
}
