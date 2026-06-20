import { CostManager } from '@/components/admin/costs/CostManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 予想コストの可視化 (issue #89, increment 1)。 */
export default function AdminCostsPage() {
  return <CostManager />;
}
