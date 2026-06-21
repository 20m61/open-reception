import { StaffResponseManager } from '@/components/admin/StaffResponseManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 担当者応答アクション設定（有効/無効・来訪者文言上書き）(issue #99 inc2)。 */
export default function AdminStaffResponsePage() {
  return <StaffResponseManager />;
}
