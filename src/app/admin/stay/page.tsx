import { StayManager } from '@/components/admin/StayManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 在館状況と退館管理 (issue #102)。 */
export default function AdminStayPage() {
  return <StayManager />;
}
