import { StaffManager } from '@/components/admin/StaffManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 担当者管理 (issue #26)。 */
export default function AdminStaffPage() {
  return <StaffManager />;
}
