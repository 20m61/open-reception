import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getKiosk, getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { getDeviceService } from '@/lib/tenant/store';
import { resolveDeviceBinding } from '@/lib/product-context/device-binding';
import { recordDeploymentReport } from '@/lib/experience-version/deployment-store';

/**
 * GET /api/kiosk/heartbeat?kioskId=... — 受付端末の定期確認 (issue #30)。
 * 端末有効性（失効/緊急停止）と許可状態を返し、長期表示中の変化を検知できるようにする。
 *
 * Kiosk→Device 統合 (issue #87 inc3): この heartbeat を Device.lastSeenAt に反映し、
 * 管理画面（/admin/devices・/admin/sites）や死活集計 (#261) の稼働状態を実活動から導く。
 * 対応 Device が無い kiosk（旧レジストリのみの端末）は、kiosk レジストリでの実在を確認して
 * Device へ取り込む（#261: Device を source-of-truth へ寄せる片方向同期。未登録 id は
 * 取り込まないため、無認可 heartbeat からの任意行作成にはならない）。
 *
 * false-offline 方針 (#261): 記録は best-effort（30 秒間隔）で、失敗しても heartbeat 応答は
 * 止めない。オンライン窓は 5 分（DEFAULT_ONLINE_WINDOW_MS）= 10 周期分あり、単発の書込失敗は
 * 次周期が実質リトライとなって false-offline にならない。即時リトライは持たない。
 *
 * 構成の反映報告 (#420 Inc3): 端末は読み込んだ受付体験版を
 * `?loadedRevision=&loadedConfigHash=`（および読込失敗時は `&errorCode=&errorRevision=`）で
 * 報告する。`loadedConfigHash` は `/api/configuration/effective` 応答の `version.contentHash`
 * （内容の指紋）で、端末ごとに変わる `configHash` ではない。記録は lastSeenAt と同じく
 * **セッション紐づけ + best-effort**（偽報告の注入を防ぎ、失敗しても heartbeat は止めない）。
 *
 * 死活記録のセッション紐づけ (#284 inc1): lastSeenAt 更新・adoptKiosk は、有効な kiosk
 * セッション（cookie）を持ち、かつセッションの kioskId がクエリの kioskId と一致する
 * リクエストに限る。これで kioskId を知るだけの外部者が GET を叩いて「偽 online」を注入する
 * 経路を塞ぐ。セッション無し/不一致は**記録だけをスキップ**し、応答（active/pinRequired/
 * authorized/serverTime）は従来互換のまま返す — 未エンロール端末の失効検知・緊急停止検知や
 * authorized による導線分岐（#239）を壊さないため。
 */
/** 正の整数のみ受理する（不正値は未報告として扱う）。 */
function readRevision(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 端末が報告した errorCode を正規化する（ログ/画面に出るため文字種と長さを制限）。 */
function readErrorCode(params: URLSearchParams): string | undefined {
  const raw = params.get('errorCode');
  if (!raw) return undefined;
  const trimmed = raw.trim().slice(0, 64);
  return /^[a-z0-9_.-]+$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * 端末の構成反映報告を記録する。端末台帳から tenant/site を fail-closed で解決し、
 * 未登録端末の報告は捨てる（任意行の作成を許さない）。
 */
async function recordConfigurationReport(
  kioskId: string,
  params: URLSearchParams,
): Promise<void> {
  const loadedRevision = readRevision(params, 'loadedRevision');
  const loadedConfigHash = params.get('loadedConfigHash')?.trim() || undefined;
  const errorCode = readErrorCode(params);
  // 何も報告していない heartbeat では書き込まない（既存の 30 秒周期に無用な書込を足さない）。
  if (loadedRevision === undefined && loadedConfigHash === undefined && errorCode === undefined) {
    return;
  }

  const binding = await resolveDeviceBinding(kioskId);
  if (!binding) return;

  await recordDeploymentReport({
    kioskId: binding.kioskId,
    tenantId: binding.tenantId,
    siteId: binding.siteId,
    loadedRevision,
    loadedConfigHash,
    errorCode,
    errorRevision: readRevision(params, 'errorRevision'),
    reportedAt: new Date().toISOString(),
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = await getKioskConfig(kioskId);
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  // Device の lastSeenAt 更新・取り込みは heartbeat 応答に影響させない（best-effort）。
  // 記録はセッションに紐づく端末自身の heartbeat に限定する（#284 inc1。空 id はセッションを
  // 発行しないため一致し得ず、ここで同時に短絡される — DynamoDB の空 SK 回避の既存規約も維持）。
  if (session !== null && session.kioskId === kioskId && kioskId.trim() !== '') {
    try {
      const service = getDeviceService();
      const { matched } = await service.recordHeartbeat(kioskId);
      if (!matched) {
        const kiosk = await getKiosk(kioskId);
        if (kiosk.ok) {
          await service.adoptKiosk(
            {
              id: kiosk.value.id,
              displayName: kiosk.value.displayName,
              ...(kiosk.value.location !== undefined ? { location: kiosk.value.location } : {}),
              enabled: kiosk.value.enabled,
            },
            resolveDefaultScope(),
          );
        }
      }
    } catch {
      // Device 統合は補助的な read 経路。失敗しても端末の動作確認は継続する。
    }

    try {
      await recordConfigurationReport(kioskId, new URL(request.url).searchParams);
    } catch {
      // 反映報告も best-effort。次周期の heartbeat が実質リトライになる。
    }
  }
  return NextResponse.json({
    active: effectiveKioskActive(config.active, security.emergencyStop),
    pinRequired: security.pinRequired,
    authorized: session !== null,
    serverTime: new Date().toISOString(),
  });
}
