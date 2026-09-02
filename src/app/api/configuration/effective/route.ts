import { NextResponse } from 'next/server';
import {
  contextDenialStatus,
  resolveProductContext,
  type RequestedScope,
} from '@/domain/product-context/context';
import { createEffectiveKioskConfigurationResolver } from '@/domain/product-context/resolver';
import type { ConfigurationVersionSelector } from '@/domain/product-context/types';
import { resolveAdminActorWithIdentity } from '@/lib/auth/actor';
import { requireKioskSession } from '@/lib/kiosk/session-guard';
import { deviceActorFor, resolveDeviceBinding } from '@/lib/product-context/device-binding';
import { resolveConfigurationPlan } from '@/lib/product-context/configuration-plan';

/**
 * GET /api/configuration/effective?tenantId=&siteId=&kioskId=&version=draft|published (issue #419)
 *
 * 端末に実際に適用される構成を 1 レスポンスで返す。**プレビューと本番実行で同じ resolver**を通す
 * ため、同一 version なら `configHash` が一致する（AC1）。
 *
 * 権威の取り方（`resolveProductContext`）:
 *   - kiosk セッションがあれば **端末実行**。tenant/site/kiosk は端末台帳から解決し、query は
 *     信用しない。未登録・失効端末は 403（既定テナントの構成へ落とさない）。draft は配信しない。
 *   - セッションが無ければ **管理プレビュー**。actor の割り当てと query の tenant/site を照合し、
 *     さらに **kioskId が当該拠点の端末であること**を台帳で確認する（いずれも越境は 403）。
 *
 * 配信元（#420 increment 2）: 公開版がスナップショットを持てばそこから配り、可変ストアは読まない。
 * 版管理をまだ使っていない拠点は live なストアから配る（従来どおり）。詳細は
 * `src/lib/product-context/configuration-plan.ts`。
 *
 * 既存の個別設定 API（`/api/kiosk/branding` 等）は互換経路として**残す**。撤去条件は
 * `docs/product-integration-plan.md` §4.1 / §9 B-03 を参照。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const requested: RequestedScope = {
    tenantId: params.get('tenantId') ?? undefined,
    siteId: params.get('siteId') ?? undefined,
    kioskId: params.get('kioskId') ?? undefined,
  };
  const version: ConfigurationVersionSelector =
    params.get('version') === 'draft' ? { kind: 'draft' } : { kind: 'published' };

  const session = await requireKioskSession();

  let resolution;
  if (session) {
    const binding = await resolveDeviceBinding(session.kioskId);
    if (!binding) {
      return NextResponse.json(
        { error: 'device_not_registered', message: 'kiosk is not registered or revoked' },
        { status: 403 },
      );
    }
    resolution = resolveProductContext({
      actorId: binding.kioskId,
      actor: deviceActorFor(binding),
      area: 'kiosk-runtime',
      deviceBinding: binding,
      requested,
      version,
    });
  } else {
    const admin = await resolveAdminActorWithIdentity();
    if (!admin) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    resolution = resolveProductContext({
      actorId: admin.identity,
      actor: admin.actor,
      area: 'kiosk-preview',
      requested,
      version,
    });
  }

  if (!resolution.ok) {
    return NextResponse.json(
      { error: resolution.reason },
      { status: contextDenialStatus(resolution.reason) },
    );
  }

  const context = resolution.value;
  if (context.area === 'kiosk-preview') {
    // `resolveProductContext` は tenant/site の越境を弾くが、「その kioskId が本当にその拠点の
    // 端末か」は台帳を引かないと分からない（純関数では担保できない義務）。ここで閉じないと、
    // 他テナントの端末 ID を指定して当該テナントの機能フラグ値が観測できてしまう。
    const target = await resolveDeviceBinding(context.kioskId ?? '');
    if (
      !target ||
      target.tenantId !== context.tenantId ||
      target.siteId !== context.siteId
    ) {
      return NextResponse.json(
        { error: 'kiosk_not_in_scope', message: 'kiosk does not belong to the selected site' },
        { status: 403 },
      );
    }
  }

  if (!context.tenantId || !context.siteId || !context.kioskId) {
    return NextResponse.json({ error: 'scope_required' }, { status: 400 });
  }

  // 公開版がスナップショットを持つなら、可変ストアではなくスナップショットから配る（#420）。
  const plan = await resolveConfigurationPlan({
    tenantId: context.tenantId,
    siteId: context.siteId,
    selector: version,
  });
  if (!plan) {
    return NextResponse.json({ error: 'version_not_found' }, { status: 404 });
  }

  const resolver = createEffectiveKioskConfigurationResolver({
    versions: { resolve: () => plan.version },
    loaders: plan.loaders,
  });
  const result = await resolver.resolve(context, version);

  if (result.ok) return NextResponse.json(result.value);

  switch (result.error.reason) {
    case 'version_not_found':
      return NextResponse.json({ error: 'version_not_found' }, { status: 404 });
    case 'draft_not_allowed':
      return NextResponse.json({ error: 'draft_not_allowed' }, { status: 403 });
    case 'context_incomplete':
      return NextResponse.json({ error: 'scope_required' }, { status: 400 });
    case 'section_unavailable':
      // 部分構成は返さない。端末・管理画面は既存の個別 API へ切り戻せる（rollback playbook）。
      return NextResponse.json(
        { error: 'section_unavailable', section: result.error.section },
        { status: 503 },
      );
    case 'forbidden_value':
      // 秘匿値・PII の混入はサーバ側の設定不備。**キーのパスは応答に出さない**（section まで）。
      return NextResponse.json(
        { error: 'configuration_rejected', section: result.error.section },
        { status: 500 },
      );
  }
}
