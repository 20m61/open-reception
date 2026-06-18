import { VoiceManager } from '@/components/admin/VoiceManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 音声設定 (issue #28)。 */
export default function AdminVoicePage() {
  return <VoiceManager />;
}
