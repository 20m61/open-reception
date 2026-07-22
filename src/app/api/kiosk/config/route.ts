import { NextResponse } from 'next/server';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { resolveKioskMaintenance } from '@/lib/platform/maintenance-gate';
import { resolveKioskOperatingStatusById } from '@/lib/operating-policy/kiosk-gate';

/**
 * GET /api/kiosk/config?kioskId=... — 受付端末の設定取得 (issue #18, #29)。
 * 失効・未登録端末、または緊急停止中は active=false を返し、受付開始を停止する。
 *
 * #290 item3: プラットフォームコンソールで登録した予定メンテナンス（MaintenanceWindow）を実際に
 * 効かせる。端末のスコープ（tenant/site/device、platform は全端末）に現在有効なメンテナンスがあれば
 * `maintenance`（impact/message/endsAt）を返し、影響度 `unavailable` のときは active=false にして
 * 受付開始を止める（read_only 等の軽い影響は active を維持し案内表示に委ねる）。判定不能時は fail-open
 * （maintenance=null・active は既存ロジックのまま）。
 *
 * #367: 保存済み `ServiceOperatingPolicy`（kioskId → Device → tenant/site 解決、
 * `lib/operating-policy/kiosk-gate.ts`）から判定した営業状態を `operatingStatus` として返す。
 * `src/components/kiosk/KioskFlow.tsx` の `operatingStatus` prop契約（`@/domain/kiosk/operating-status`）
 * にそのまま渡せる形。ポリシー未設定・判定不能は `operatingStatus: null`（fail-open。
 * `operatingStateOf` が「判定不能」として通常受付に倒す）。
 * 営業中→時間外の切替は、この応答を再取得するたびに反映される（KioskFlow 側の既存ポーリング/
 * 再取得周期に委ねる。専用のプッシュ通知は本 increment のスコープ外）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const [config, security, maintenance, operatingStatus] = await Promise.all([
    getKioskConfig(kioskId),
    getSecuritySettings(),
    resolveKioskMaintenance(kioskId),
    resolveKioskOperatingStatusById(kioskId),
  ]);
  const active =
    effectiveKioskActive(config.active, security.emergencyStop) &&
    maintenance?.impact !== 'unavailable';
  return NextResponse.json({
    ...config,
    active,
    maintenance: maintenance ?? null,
    operatingStatus: operatingStatus ?? null,
  });
}
