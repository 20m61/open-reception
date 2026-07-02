import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/data-stores/reception-log-store';
import { isBreakGlassAudit } from '@/domain/auth/elevation';
import { toMaskedAuditRows } from '@/domain/platform/console-summary';
import { shouldRecordAuditView } from '@/domain/platform/read-audit';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { recordPlatformReadAudit } from '@/lib/platform/read-audit';

/** 返す監査ログ件数の上限（新しい順）。 */
const LIMIT = 100;

/**
 * GET /api/platform/audit-logs — テナント横断のマスク済み監査ログ read (issue #90, increment 2)。
 *
 * developer 専用の read-only API。既存の監査基盤（listAuditLogs）から新しい順に取得し、
 * actor の識別子部分をマスクした最小行のみを返す。AuditLog 設計上 PII は記録されないが、
 * actor のメール等が混入しても露出しないよう純関数 toMaskedAuditRows でマスクする。
 * metadata は表示に載せない（#83 PII・機密非露出方針）。
 *
 * break-glass 利用後レビュー (#83 §3): `?breakGlass=1` で break-glass の発行/終了
 * （`privilege.break_glass`）と break-glass 中の全 write（metadata.breakGlass='true'）だけに
 * 絞れる。各行には表示用の `breakGlass:true` を付ける（metadata そのものは露出しない）。
 *
 * 閲覧監査 (#83 §5 / inc5b): 監査ログ閲覧そのものを `platform.audit_log.viewed` として記録する。
 * 閲覧のたびに記録すると「閲覧 → 記録 → 一覧に増える」の自己増殖で実操作の記録を押し流すため、
 * 同一 actor の窓内（15 分）連続閲覧は 1 回に絞る。抑制判定は取得済みログ（ストア）上の閲覧監査に
 * 基づく純関数で行い、プロセス内状態を持たない（サーバーレスの複数インスタンスでも効く）。
 * 判定は絞り込み前の全ログ基準（breakGlass フィルタで窓が素通りしない）。記録失敗は伝播させる
 * （未監査の閲覧に監査ログを返さない・fail-closed）。
 *
 * 認可: authorizePlatformWithIdentity()（未認証 401 / 非 developer 403。identity は閲覧監査の帰属に使う）。
 */
export async function GET(request?: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;

  const onlyBreakGlass = request
    ? new URL(request.url).searchParams.get('breakGlass') === '1'
    : false;
  const logs = await listAuditLogs();

  // 閲覧監査 (#83 §5)。今回の応答には載らない（次回取得から一覧に現れる＝透明性は保たれる）。
  const viewer = `platform:${auth.identity}`;
  if (shouldRecordAuditView(logs, viewer, Date.now())) {
    await recordPlatformReadAudit({
      action: 'platform.audit_log.viewed',
      identity: auth.identity,
      target: { type: 'audit_log' },
      request,
    });
  }

  const visible = onlyBreakGlass ? logs.filter((log) => isBreakGlassAudit(log)) : logs;
  // toMaskedAuditRows は 1:1・順序保存の射影。同 index の元ログから breakGlass フラグを導出する。
  const rows = toMaskedAuditRows(visible).map((row, i) => {
    const source = visible[i];
    return source && isBreakGlassAudit(source) ? { ...row, breakGlass: true as const } : row;
  });
  return NextResponse.json({ logs: rows.slice(0, LIMIT) });
}
