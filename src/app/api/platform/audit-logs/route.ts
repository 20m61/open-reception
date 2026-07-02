import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/data-stores/reception-log-store';
import { isBreakGlassAudit } from '@/domain/auth/elevation';
import { toMaskedAuditRows } from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

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
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(request?: Request): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const onlyBreakGlass = request
    ? new URL(request.url).searchParams.get('breakGlass') === '1'
    : false;
  const logs = await listAuditLogs();
  const visible = onlyBreakGlass ? logs.filter((log) => isBreakGlassAudit(log)) : logs;
  // toMaskedAuditRows は 1:1・順序保存の射影。同 index の元ログから breakGlass フラグを導出する。
  const rows = toMaskedAuditRows(visible).map((row, i) => {
    const source = visible[i];
    return source && isBreakGlassAudit(source) ? { ...row, breakGlass: true as const } : row;
  });
  return NextResponse.json({ logs: rows.slice(0, LIMIT) });
}
