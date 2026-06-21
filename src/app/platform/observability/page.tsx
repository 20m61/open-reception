import { Observability } from '@/components/admin/platform/Observability';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: 可観測性（read 中心） (issue #90, increment 2)。
 * data 取得・認可は /api/platform/observability（developer 専用 read）。
 * 直近ログはマスク済みで PII を露出しない。指標ソースの接続は次増分。
 */
export default function PlatformObservabilityPage() {
  return <Observability />;
}
