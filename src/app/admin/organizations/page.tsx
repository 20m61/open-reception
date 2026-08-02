import { OrganizationsManager } from '@/components/admin/OrganizationsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 組織（来訪者への見せ方） (#373)。 */
export default function AdminOrganizationsPage() {
  return <OrganizationsManager />;
}
