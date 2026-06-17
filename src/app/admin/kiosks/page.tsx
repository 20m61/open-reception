import { KiosksManager } from '@/components/admin/KiosksManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 受付端末管理 (issue #18)。 */
export default function AdminKiosksPage() {
  return <KiosksManager />;
}
