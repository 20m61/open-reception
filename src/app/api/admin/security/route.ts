import { isPinConfigured } from '@/domain/security/pin';
import { NextResponse } from 'next/server';
import { asTenantId } from '@/domain/tenant/types';
import { readSecuritySettings, updateSecuritySettings } from '@/lib/security/security-store';
import { readJson } from '@/lib/data-stores/result-http';
import {
  assertCanRead,
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { recordDangerAction } from '@/lib/admin/audit';
import { buildActorConfig } from '@/lib/auth/actor';

/**
 * GET /api/admin/security — セキュリティ設定の取得 (issue #23, #29)。
 * PIN 値そのものは返さず、設定済みかどうかのみ返す。
 * PUT /api/admin/security — 設定の更新（緊急停止を含むガバナンス系の危険操作）。
 *
 * 認可（#91 適用例）: middleware の入口ガードに加え、route 側で実 actor を解決し
 * `requireActor` / `assertCanWrite` で **最終認可** を行う（フロントで隠した操作でも 403）。
 * 監査（#91）: 更新は `recordDangerAction` で記録する。PIN 値などの機微値は残さない。
 */

/** セキュリティ設定はテナント既定スコープで扱う（単一テナント運用の既定）。 */
function securityTenantId() {
  return asTenantId(buildActorConfig().defaultTenantId);
}

export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, securityTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { settings: s, storedPinUnreadable } = await readSecuritySettings();
  return NextResponse.json({
    pinRequired: s.pinRequired,
    ipAllowlist: s.ipAllowlist,
    pinConfigured: isPinConfigured(s),
    emergencyStop: s.emergencyStop,
    // 🔴 保存されていた PIN を読めず、組込み既定で代用しているか (#1160 AC2)。
    //    真偽だけを返す（値・どう壊れていたかは返さない）。
    storedPinUnreadable,
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, securityTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  // 🔴 **body は 1 度だけ読む。** `pinChanged` は「PIN を送ったか」で決める
  //    （レビュー 2 周目 MAJOR 2）——「未設定→設定済みの遷移」では**ローテーションが
  //    全部 false** になり、退職・漏洩時の変更が監査から消える（実測）。
  //    🔴 語義は厳密には「**PIN 欄に入力して保存した**」である（同じ値の再投入も true）。
  //    値を比較できない以上こうなる（レビュー 3 周目 MINOR 10）。
  const patch = await readJson(request);
  const updated = await updateSecuritySettings(patch);
  const pinChanged =
    typeof (patch as { pin?: unknown } | null)?.pin === 'string' &&
    ((patch as { pin: string }).pin.trim() !== '');
  // 既存 AuditAction（security.updated）を使用。機微値（PIN）は metadata に残さない。
  await recordDangerAction({
    action: 'security.updated',
    target: { type: 'security' },
    metadata: {
      pinRequired: updated.pinRequired,
      emergencyStop: updated.emergencyStop,
      // 🔴 **値は残さず、変えたことだけ残す（レビュー 1 周目 MINOR 6）。**
      //    運用調査（「いつ誰が PIN を変えたか」）に効く。PII/secret は載せない。
      pinChanged,
    },
  });
  return NextResponse.json({
    pinRequired: updated.pinRequired,
    ipAllowlist: updated.ipAllowlist,
    pinConfigured: isPinConfigured(updated),
    emergencyStop: updated.emergencyStop,
    // 更新は必ず読める記録（ハッシュ）を書くので、書いた直後の記録は読める。
    // 🔴 読めなかった記録を上書きした事実は `security.pin_credential_defaulted` の監査が
    //    上書きの前に残している（#1160）。
    storedPinUnreadable: false,
  });
}
