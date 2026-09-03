'use client';

import { useEffect, useState } from 'react';
import type { MaskedAuditRow } from '@/domain/platform/console-summary';
import { DataTable, type Column } from '@/components/admin/ui';

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

const COLUMNS: ReadonlyArray<Column<AuditRow>> = [
  { key: 'at', header: '日時', cell: (log) => log.at, cellStyle: () => ({ opacity: 0.8 }) },
  {
    key: 'action',
    header: '操作',
    cell: (log) => (
      <>
        {log.action}
        {log.breakGlass ? (
          <span
            style={{
              marginLeft: 6,
              padding: '1px 6px',
              borderRadius: 6,
              fontSize: '0.72rem',
              color: 'var(--color-platform-danger)',
              border: '1px solid color-mix(in srgb, var(--color-platform-danger) 50%, transparent)',
            }}
          >
            break-glass
          </span>
        ) : null}
      </>
    ),
  },
  { key: 'actor', header: '主体', cell: (log) => log.actor, cellStyle: () => ({ opacity: 0.7 }) },
  {
    key: 'target',
    header: '対象',
    cell: (log) => (
      <>
        {log.targetType ?? '-'}
        {log.targetId ? <span style={{ opacity: 0.6 }}> {log.targetId}</span> : null}
      </>
    ),
    cellStyle: () => ({ opacity: 0.7 }),
  },
  {
    key: 'detail',
    header: '詳細',
    cell: (log) => (
      <>
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
      </>
    ),
    cellStyle: () => ({ opacity: 0.7, fontSize: '0.82rem' }),
  },
];

export function AuditLogs() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // break-glass のみ表示（利用後レビュー, #83 §3）。絞り込みはサーバ側（?breakGlass=1）で行う。
  const [breakGlassOnly, setBreakGlassOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/platform/audit-logs${breakGlassOnly ? '?breakGlass=1' : ''}`);
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '監査ログの取得に失敗しました。');
          return;
        }
        setError(null);
        setData((await res.json()) as AuditResponse);
      /*
       * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
       * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
       * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
       * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
       * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
       */
      } catch {
        if (!cancelled) setError('監査ログの取得に失敗しました。');
      }
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

      {error ? <p role="alert" style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。あわせて「まだ読めていない」を
        0 件と混ぜないようにした（移行前は `data && logs.length === 0` の分岐だったため、
        読み込み中・失敗のときは**空の表だけ**が出ていた）。
      */}
      <DataTable
        testId="platform-audit-logs"
        scrollRegionLabel="監査ログ"
        columns={COLUMNS}
        rows={logs}
        rowKey={(log) => log.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage={
          breakGlassOnly ? 'break-glass の利用記録はありません。' : 'まだ監査ログはありません。'
        }
        failureMessage="監査ログを読み込めませんでした。"
      />
    </section>
  );
}
