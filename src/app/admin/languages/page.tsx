import { LanguageSettingsManager } from '@/components/admin/LanguageSettingsManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 言語設定 (issue #103)。有効言語・既定言語を編集する。 */
export default function AdminLanguagesPage() {
  return <LanguageSettingsManager />;
}
