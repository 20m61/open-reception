import { IntegrationsManager } from '@/components/admin/integrations/IntegrationsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 認証方式・外部連携・シークレット状態 (issue #93)。 */
export default function AdminIntegrationsPage() {
  return <IntegrationsManager />;
}
