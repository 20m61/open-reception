'use client';

import { useEffect, useState } from 'react';
import type { MaskedAuditRow } from '@/domain/platform/console-summary';

/**
 * 監査ログ（テナント横断・マスク済み read） (issue #90, increment 2)。
 *
 * /api/platform/audit-logs（developer 専用 read）から、新しい順のマスク済み監査ログを表示する。
 * actor の識別子はマスク済みで、metadata は表示しない（PII・機密非露出）。高詳細監査 (#83 AC13) の
 * before/after 差分・操作元 IP は記録時に sanitize 済みのため表示する（機微値/PII は含まない）。
 *
 * break-glass 利用後レビュー (#83 §3): 各行の breakGlass フラグ（API 側で action/metadata から導出）を
 * バッジ表示し、`?breakGlass=1` の絞り込みトグルで発行〜write〜終了の一連をレビューできる。
 */
type AuditRow = MaskedAuditRow & { breakGlass?: boolean };
type AuditResponse = { logs: AuditRow[] };

/** before/after を `key: 変更前→変更後` の短い差分表記へ（sanitize 済みのため機密値は無い）(#83 AC13)。 */
function formatDiff(before?: Record<string, string>, after?: Record<string, string>): string {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].map((k) => `${k}: ${before?.[k] ?? '-'}→${after?.[k] ?? '-'}`).join(', ');
}

export function AuditLogs() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // break-glass のみ表示（利用後レビュー, #83 §3）。絞り込みはサーバ側（?breakGlass=1）で行う。
  const [breakGlassOnly, setBreakGlassOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/platform/audit-logs${breakGlassOnly ? '?breakGlass=1' : ''}`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '監査ログの取得に失敗しました。');
        return;
      }
      setError(null);
      setData((await res.json()) as AuditResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, [breakGlassOnly]);

  const logs = data?.logs ?? [];

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>監査ログ</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        プラットフォーム操作のマスク済み監査ログを横断確認します（読み取り専用）。操作主体は
        マスク済みで、個人情報・機密値は表示しません。
      </p>

      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 'var(--space-md)' }}>
        <input
          type="checkbox"
          checked={breakGlassOnly}
          onChange={(e) => setBreakGlassOnly(e.target.checked)}
          aria-label="break-glass のみ表示"
        />
        <span>break-glass のみ表示（緊急権限の利用後レビュー）</span>
      </label>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      {data && logs.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          {breakGlassOnly ? 'break-glass の利用記録はありません。' : 'まだ監査ログはありません。'}
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: '6px 8px' }}>日時</th>
              <th style={{ padding: '6px 8px' }}>操作</th>
              <th style={{ padding: '6px 8px' }}>主体</th>
              <th style={{ padding: '6px 8px' }}>対象</th>
              <th style={{ padding: '6px 8px' }}>詳細</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <td style={{ padding: '6px 8px', opacity: 0.8 }}>{log.at}</td>
                <td style={{ padding: '6px 8px' }}>
                  {log.action}
                  {log.breakGlass ? (
                    <span
                      style={{
                        marginLeft: 6,
                        padding: '1px 6px',
                        borderRadius: 6,
                        fontSize: '0.72rem',
                        color: '#e66e6e',
                        border: '1px solid rgba(230,110,110,0.5)',
                      }}
                    >
                      break-glass
                    </span>
                  ) : null}
                </td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{log.actor}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>
                  {log.targetType ?? '-'}
                  {log.targetId ? <span style={{ opacity: 0.6 }}> {log.targetId}</span> : null}
                </td>
                <td style={{ padding: '6px 8px', opacity: 0.7, fontSize: '0.82rem' }}>
                  {log.before || log.after ? <span>{formatDiff(log.before, log.after)}</span> : null}
                  {log.ip ? <span style={{ opacity: 0.6 }}> · {log.ip}</span> : null}
                  {log.userAgent ? (
                    // UA は長いので切り詰めて表示（全文は title で確認）。
                    <span style={{ opacity: 0.5 }} title={log.userAgent}>
                      {' '}
                      · {log.userAgent.length > 40 ? `${log.userAgent.slice(0, 40)}…` : log.userAgent}
                    </span>
                  ) : null}
                  {!log.before && !log.after && !log.ip && !log.userAgent ? '-' : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
