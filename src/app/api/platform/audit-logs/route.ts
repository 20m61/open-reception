import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/data-stores/reception-log-store';
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
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const logs = await listAuditLogs();
  return NextResponse.json({ logs: toMaskedAuditRows(logs).slice(0, LIMIT) });
}
