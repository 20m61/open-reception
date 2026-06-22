import { AiGuidanceManager } from '@/components/admin/AiGuidanceManager';

export const dynamic = 'force-dynamic';

/** 管理画面: AI 案内設定（有効/無効・許可トピック）(issue #104)。 */
export default function AdminAiGuidancePage() {
  return <AiGuidanceManager />;
}
