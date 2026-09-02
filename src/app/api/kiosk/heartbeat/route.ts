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
 * セッション（cookie）を持つリクエストに限る。これで kioskId を知るだけの外部者が GET を
 * 叩いて「偽 online」を注入する経路を塞ぐ。セッション無しは**記録だけをスキップ**し、応答
 * （active/pinRequired/authorized/serverTime）は従来互換のまま返す — 未エンロール端末の
 * 失効検知・緊急停止検知や authorized による導線分岐（#239）を壊さないため。
 *
 * **端末 ID はセッションが権威** (#419 / 台帳 §6 の `kiosk-dev` 除去): セッションが在れば
 * クエリの `kioskId` は**信用せず無視**する。かつてクライアントは `kiosk-dev` 固定値を送って
 * おり、実際のエンロール端末（ランダム UUID）と食い違っていた。その結果:
 *
 *   - セッションの kioskId と一致しないため、**死活も反映報告も記録されなかった**。
 *   - 有効性（active）を全端末が seed 端末 `kiosk-dev` の設定から読んでいた。つまり個別端末の
 *     失効が受付画面に効かず、逆に seed を無効化すると全端末が止まる状態だった（#30 の意図と逆）。
 *
 * 有効性の解決も**端末台帳（device）を先に見る**。エンロール端末は旧 kiosk レジストリに存在
 * しないため、旧レジストリだけを見ると正常な端末が「失効」になる。台帳に無い端末（旧レジストリ
 * のみの `kiosk-dev` seed 等）は従来どおり `getKioskConfig` で判定する。
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
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  // セッションが在ればそれが権威。無ければ未エンロール端末なのでクエリを使う（失効検知は続ける）。
  const kioskId = session?.kioskId ?? new URL(request.url).searchParams.get('kioskId') ?? '';
  // 台帳に居る端末は台帳の status が正（fail-closed で null = 失効/未登録）。
  // 台帳に無い端末は旧 kiosk レジストリで判定する（`kiosk-dev` seed 等の互換経路）。
  //
  // **身元が全く分からない要求（セッション無し・kioskId 無し）は active を fail-open で true に
  // する。** 「失効」と「未エンロール」は別物で、身元が無いことは失効の証拠ではない。false に
  // 倒すと、まだエンロールしていない端末に「この端末は現在ご利用いただけません」を出してしまい、
  // エンロール導線（#239 の未エンロール案内）へ進めなくなる。受付フロー自体は authorized=false の
  // ゲートで塞がれており、緊急停止は下の effectiveKioskActive で別途効く。
  const binding = session ? await resolveDeviceBinding(kioskId) : null;
  const active =
    binding !== null ? true : kioskId.trim() === '' ? true : (await getKioskConfig(kioskId)).active;
  // Device の lastSeenAt 更新・取り込みは heartbeat 応答に影響させない（best-effort）。
  // 記録はセッションに紐づく端末自身の heartbeat に限定する（#284 inc1。空 id はセッションを
  // 発行しないため一致し得ず、ここで同時に短絡される — DynamoDB の空 SK 回避の既存規約も維持）。
  if (session !== null && kioskId.trim() !== '') {
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
    active: effectiveKioskActive(active, security.emergencyStop),
    pinRequired: security.pinRequired,
    authorized: session !== null,
    serverTime: new Date().toISOString(),
  });
}
