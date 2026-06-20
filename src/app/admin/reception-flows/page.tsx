import { ReceptionFlowsManager } from '@/components/admin/ReceptionFlowsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 来訪目的別カスタム受付フロー管理 (issue #100)。 */
export default function AdminReceptionFlowsPage() {
  return <ReceptionFlowsManager />;
}
