import { NextResponse } from 'next/server';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { resolveKioskMaintenance } from '@/lib/platform/maintenance-gate';

/**
 * GET /api/kiosk/config?kioskId=... — 受付端末の設定取得 (issue #18, #29)。
 * 失効・未登録端末、または緊急停止中は active=false を返し、受付開始を停止する。
 *
 * #290 item3: プラットフォームコンソールで登録した予定メンテナンス（MaintenanceWindow）を実際に
 * 効かせる。端末のスコープ（tenant/site/device、platform は全端末）に現在有効なメンテナンスがあれば
 * `maintenance`（impact/message/endsAt）を返し、影響度 `unavailable` のときは active=false にして
 * 受付開始を止める（read_only 等の軽い影響は active を維持し案内表示に委ねる）。判定不能時は fail-open
 * （maintenance=null・active は既存ロジックのまま）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const [config, security, maintenance] = await Promise.all([
    getKioskConfig(kioskId),
    getSecuritySettings(),
    resolveKioskMaintenance(kioskId),
  ]);
  const active =
    effectiveKioskActive(config.active, security.emergencyStop) &&
    maintenance?.impact !== 'unavailable';
  return NextResponse.json({ ...config, active, maintenance: maintenance ?? null });
}
