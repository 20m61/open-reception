import { DevicesManager } from '@/components/admin/DevicesManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 受付端末管理 (issue #87, increment 2)。 */
export default function AdminDevicesPage() {
  return <DevicesManager />;
}
