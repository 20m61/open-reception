import { ReservationsManager } from '@/components/admin/ReservationsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 来訪予約と QR 発行 (issue #97)。 */
export default function AdminReservationsPage() {
  return <ReservationsManager />;
}
