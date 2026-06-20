'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VisitStay } from '@/domain/visit/types';
import {
  Button,
  CardGrid,
  DataTable,
  Field,
  MetricCard,
  Section,
  StatusBadge,
  type Column,
} from '@/components/admin/ui';
import { color, radius, space } from '@/components/admin/ui/tokens';
import {
  availableActions,
  durationText,
  sortStays,
  statusKind,
  statusLabel,
  summarize,
} from './stay/logic';

/**
 * 滞在状況 管理画面 (issue #102, increment 1)。
 *
 * inc1 の滞在 API（/api/admin/stay/**）を介して在館中 / 退館済み / 未退館を一覧表示し、
 * 在館者を退館済みにする（誤登録は取消）。
 *
 * 表示変換・集計・操作可否は副作用なしの純ロジック（./stay/logic.ts）へ委譲する。
 * VisitStay に PII は無く、来訪者識別は参照（受付番号 = id / receptionId）のみ。
 *
 * actor の実テナント解決は #80 配線に依存する。inc1 は単一テナント運用の互換シード
 * `internal` を既定にし、siteId は画面上部で選択（暫定は手入力 + 既定値）する。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default';

export function StayManager({
  tenantId = DEFAULT_TENANT_ID,
  initialSiteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  initialSiteId?: string;
}) {
  const [siteId, setSiteId] = useState(initialSiteId);
  const [items, setItems] = useState<VisitStay[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 滞在時間表示の基準。マウント時刻で固定し、再レンダの揺れを抑える。
  const [now] = useState(() => new Date());

  const scopeQuery = useMemo(
    () => `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    [tenantId, siteId],
  );

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/admin/stay?${scopeQuery}`);
    if (res.ok) {
      setItems((await res.json()) as VisitStay[]);
    } else {
      setError('滞在状況の取得に失敗しました。');
    }
  }, [scopeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId }),
        });
        if (!res.ok) setError('操作に失敗しました。');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [tenantId, siteId, load],
  );

  const checkout = useCallback((s: VisitStay) => act(`/api/admin/stay/${s.id}/checkout`), [act]);
  const cancel = useCallback((s: VisitStay) => act(`/api/admin/stay/${s.id}/cancel`), [act]);

  const summary = useMemo(() => summarize(items, now), [items, now]);
  const rows = useMemo(() => sortStays(items), [items]);

  const columns: ReadonlyArray<Column<VisitStay>> = [
    {
      key: 'id',
      header: '受付番号',
      cell: (s) => <code style={{ fontSize: '0.8rem' }}>{s.id}</code>,
    },
    { key: 'checkedInAt', header: '入館', cell: (s) => formatDateTime(s.checkedInAt) },
    {
      key: 'checkedOutAt',
      header: '退館',
      cell: (s) => (s.checkedOutAt ? formatDateTime(s.checkedOutAt) : '—'),
    },
    { key: 'duration', header: '滞在時間', cell: (s) => durationText(s, now) },
    {
      key: 'status',
      header: '状態',
      cell: (s) => <StatusBadge status={statusKind(s.status)} label={statusLabel(s.status)} />,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (s) => <RowActions stay={s} onCheckout={checkout} onCancel={cancel} busy={busy} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <div>
        <h1 style={{ marginTop: 0, marginBottom: space.xs }}>在館状況</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          テナント <code>{tenantId}</code> 配下の来訪者の在館 / 退館を確認します。滞在情報には個人情報を
          保存せず、来訪者の識別は受付番号・受付セッション参照のみで行います。
        </p>
      </div>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="拠点 ID" htmlFor="stay-site-id" hint="この拠点スコープで滞在を扱います。">
          <input
            id="stay-site-id"
            data-testid="stay-site-id"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Button data-testid="stay-refresh" onClick={() => void load()} disabled={busy}>
          更新
        </Button>
      </div>

      <Section title="状況" description="現在の滞在を状態別に集計しています。">
        <CardGrid minWidth={150}>
          <MetricCard label="合計" value={summary.total} />
          <MetricCard label="在館中" value={summary.present} tone="success" />
          <MetricCard label="未退館" value={summary.overstay} tone="warning" />
          <MetricCard label="退館済み" value={summary.checkedOut} tone="accent" />
          <MetricCard label="取消" value={summary.cancelled} />
        </CardGrid>
      </Section>

      {error ? (
        <div data-testid="stay-error" role="alert" style={{ color: color.danger, fontSize: '0.9rem' }}>
          {error}
        </div>
      ) : null}

      <Section title="滞在一覧" description="在館中を先頭に、入館の新しい順で表示します。">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          emptyMessage="この拠点の滞在記録はまだありません。"
          testId="stay-table"
        />
      </Section>
    </div>
  );
}

function RowActions({
  stay,
  onCheckout,
  onCancel,
  busy,
}: {
  stay: VisitStay;
  onCheckout: (s: VisitStay) => void;
  onCancel: (s: VisitStay) => void;
  busy: boolean;
}) {
  const actions = availableActions(stay.status);
  if (!actions.canCheckout && !actions.canCancel) return <span style={{ opacity: 0.5 }}>—</span>;
  return (
    <div style={{ display: 'inline-flex', gap: space.xs, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {actions.canCheckout ? (
        <Button variant="primary" data-testid="stay-checkout" onClick={() => onCheckout(stay)} disabled={busy}>
          退館
        </Button>
      ) : null}
      {actions.canCancel ? (
        <Button variant="danger" data-testid="stay-cancel" onClick={() => onCancel(stay)} disabled={busy}>
          取消
        </Button>
      ) : null}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}

const inputStyle: React.CSSProperties = {
  minHeight: 38,
  padding: '8px 12px',
  borderRadius: radius.sm,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  minWidth: 200,
};
