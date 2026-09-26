import { isPinConfigured, isUsablePinCredential } from '@/domain/security/pin';
import { NextResponse } from 'next/server';
import { asTenantId } from '@/domain/tenant/types';
import {
  readSecuritySettings,
  revisionOf,
  SecuritySettingsConflictError,
  SecuritySettingsInvalidError,
  SecuritySettingsPreconditionRequiredError,
  updateSecuritySettings,
} from '@/lib/security/security-store';
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
    // 🔴 保存されていた PIN を読めず、PIN 認可を誰にも通さない状態（fail closed）か (#1160 AC2)。
    //    真偽だけを返す（値・どう壊れていたかは返さない）。
    storedPinUnreadable,
    // 記録の版 (#1158)。管理画面はこれを付けて保存し、読んだ後に誰かが書いていれば 409 になる。
    rev: revisionOf(s.rev),
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
  let updated;
  try {
    updated = await updateSecuritySettings(patch);
  } catch (err) {
    // 🔴 **競合は黙って勝たない (#1158 AC2)。** 何も書いていないので監査も残さない
    //    （`security.updated` は「変えた」記録であって「変えようとした」記録ではない）。
    if (err instanceof SecuritySettingsConflictError) {
      return NextResponse.json({ error: 'conflict' }, { status: 409 });
    }
    if (err instanceof SecuritySettingsInvalidError) {
      return NextResponse.json({ error: 'invalid_rev' }, { status: 400 });
    }
    // 版を付けずに緊急停止以外を変えようとした。GET で `rev` を読んでから送り直させる。
    if (err instanceof SecuritySettingsPreconditionRequiredError) {
      return NextResponse.json({ error: 'rev_required' }, { status: 428 });
    }
    throw err;
  }
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
      // 版の遷移 (#1158。fresh-context review L2)。「どの版からどの版へ書いたか」が無いと、
      // 409 / 428 の報告と監査の行を突き合わせられない。書くたびに版は 1 つだけ進む。
      fromRev: revisionOf(updated.rev) - 1,
      rev: revisionOf(updated.rev),
    },
  });
  return NextResponse.json({
    pinRequired: updated.pinRequired,
    ipAllowlist: updated.ipAllowlist,
    pinConfigured: isPinConfigured(updated),
    emergencyStop: updated.emergencyStop,
    // 書いた記録から導く（GET と同じ判定）。読めない記録は、運用者が PIN を設定し直すまで
    // 生のまま書き戻されるので、PIN を送らない更新の後も true のまま（#1160 fail closed）。
    storedPinUnreadable: !isUsablePinCredential(updated.pin),
    rev: revisionOf(updated.rev),
  });
}
