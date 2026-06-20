'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ReservationTargetType,
  ReservationUsagePolicy,
  VisitReservation,
} from '@/domain/reservation/types';
import {
  Button,
  Card,
  CardGrid,
  DataTable,
  Field,
  FormRow,
  MetricCard,
  Section,
  StatusBadge,
  type Column,
} from '@/components/admin/ui';
import { color, radius, space } from '@/components/admin/ui/tokens';
import {
  availableActions,
  qrFileName,
  sortByVisitAt,
  statusKind,
  statusLabel,
  summarize,
  targetTypeLabel,
  usagePolicyLabel,
} from './reservations/logic';

/**
 * 来訪予約 管理画面 (issue #97, increment 2)。
 *
 * inc1 の予約 API（/api/admin/reservations/**）を介して予約の一覧・作成・編集・キャンセル・
 * 失効・QR 再発行を行い、予約ごとの QR 画像を表示/ダウンロードする。
 *
 * 表示変換・集計・操作可否は副作用なしの純ロジック（./reservations/logic.ts）へ委譲し、
 * 本コンポーネントは入出力（fetch / フォーム状態）に集中する。
 * QR には token 参照 URL のみが載り、PII は載らない（サーバ側 qr.ts で生成）。
 *
 * actor の実テナント解決は #80 配線に依存する。inc2 は単一テナント運用の互換シード
 * `internal` を既定にする（SitesManager と同方針）。siteId は運用上の必須スコープのため、
 * 画面上部で選択（暫定は手入力 + 既定値）する。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default';

type CreateForm = {
  visitorName: string;
  companyName: string;
  visitAt: string;
  note: string;
  targetType: ReservationTargetType;
  targetId: string;
  usagePolicy: ReservationUsagePolicy;
};

const EMPTY_FORM: CreateForm = {
  visitorName: '',
  companyName: '',
  visitAt: '',
  note: '',
  targetType: 'staff',
  targetId: '',
  usagePolicy: 'single_use',
};

export function ReservationsManager({
  tenantId = DEFAULT_TENANT_ID,
  initialSiteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  initialSiteId?: string;
}) {
  const [siteId, setSiteId] = useState(initialSiteId);
  const [items, setItems] = useState<VisitReservation[]>([]);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<{ id: string; dataUrl: string } | null>(null);

  const scopeQuery = useMemo(
    () => `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    [tenantId, siteId],
  );

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/admin/reservations?${scopeQuery}`);
    if (res.ok) {
      setItems((await res.json()) as VisitReservation[]);
    } else {
      setError('予約の取得に失敗しました。');
    }
  }, [scopeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (busy) return;
    if (form.visitorName.trim() === '' || form.visitAt.trim() === '' || form.targetId.trim() === '') {
      setError('来訪者名・予定日時・呼び出し先 ID は必須です。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/reservations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          siteId,
          visitorName: form.visitorName,
          companyName: form.companyName || undefined,
          visitAt: new Date(form.visitAt).toISOString(),
          note: form.note || undefined,
          targetType: form.targetType,
          targetId: form.targetId,
          usagePolicy: form.usagePolicy,
        }),
      });
      if (res.ok) {
        setForm(EMPTY_FORM);
        await load();
      } else {
        setError('予約の作成に失敗しました。');
      }
    } finally {
      setBusy(false);
    }
  }, [busy, form, tenantId, siteId, load]);

  const act = useCallback(
    async (path: string, method: 'DELETE' | 'POST') => {
      setBusy(true);
      setError(null);
      try {
        const res =
          method === 'DELETE'
            ? await fetch(`${path}?${scopeQuery}`, { method })
            : await fetch(path, {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tenantId, siteId }),
              });
        if (!res.ok) setError('操作に失敗しました。');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [scopeQuery, tenantId, siteId, load],
  );

  const cancel = useCallback((r: VisitReservation) => act(`/api/admin/reservations/${r.id}`, 'DELETE'), [act]);
  const revoke = useCallback(
    (r: VisitReservation) => act(`/api/admin/reservations/${r.id}/revoke`, 'POST'),
    [act],
  );
  const reissue = useCallback(
    (r: VisitReservation) => act(`/api/admin/reservations/${r.id}/token`, 'POST'),
    [act],
  );

  const showQr = useCallback(
    async (r: VisitReservation) => {
      setError(null);
      const res = await fetch(`/api/admin/reservations/${r.id}/qr?${scopeQuery}&format=json`);
      if (res.ok) {
        const { dataUrl } = (await res.json()) as { dataUrl: string };
        setQrFor({ id: r.id, dataUrl });
      } else {
        setError('QR の取得に失敗しました。');
      }
    },
    [scopeQuery],
  );

  const summary = useMemo(() => summarize(items), [items]);
  const rows = useMemo(() => sortByVisitAt(items), [items]);

  const columns: ReadonlyArray<Column<VisitReservation>> = [
    {
      key: 'visitor',
      header: '来訪者',
      cell: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 700 }}>{r.visitorName}</span>
          {r.companyName ? (
            <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{r.companyName}</span>
          ) : null}
        </div>
      ),
    },
    { key: 'visitAt', header: '予定日時', cell: (r) => formatDateTime(r.visitAt) },
    {
      key: 'target',
      header: '呼び出し先',
      cell: (r) => `${targetTypeLabel(r.targetType)}: ${r.targetId}`,
    },
    { key: 'usage', header: '利用制約', cell: (r) => usagePolicyLabel(r.usagePolicy) },
    {
      key: 'status',
      header: '状態',
      cell: (r) => <StatusBadge status={statusKind(r.status)} label={statusLabel(r.status)} />,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (r) => <RowActions reservation={r} onShowQr={showQr} onCancel={cancel} onRevoke={revoke} onReissue={reissue} busy={busy} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <div>
        <h1 style={{ marginTop: 0, marginBottom: space.xs }}>来訪予約</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          テナント <code>{tenantId}</code> 配下の来訪予約を管理し、来訪者へ送る QR を発行します。QR には
          個人情報を含めず、予約参照トークンのみを載せます。
        </p>
      </div>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="拠点 ID" htmlFor="reservation-site-id" hint="この拠点スコープで予約を扱います。">
          <input
            id="reservation-site-id"
            data-testid="reservation-site-id"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </div>

      <Section title="状況" description="現在の予約をステータス別に集計しています。">
        <CardGrid minWidth={150}>
          <MetricCard label="合計" value={summary.total} />
          <MetricCard label="有効" value={summary.active} tone="success" />
          <MetricCard label="使用済み" value={summary.used} tone="accent" />
          <MetricCard label="期限切れ" value={summary.expired} tone="warning" />
          <MetricCard label="失効" value={summary.revoked} tone="danger" />
          <MetricCard label="キャンセル" value={summary.cancelled} />
        </CardGrid>
      </Section>

      <Section title="予約を作成" description="作成と同時に QR トークンを発行します。">
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
            <FormRow>
              <Field label="来訪者名" htmlFor="rsv-visitor" required>
                <input id="rsv-visitor" data-testid="rsv-visitor" value={form.visitorName} onChange={(e) => setForm({ ...form, visitorName: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="会社名" htmlFor="rsv-company">
                <input id="rsv-company" data-testid="rsv-company" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="予定日時" htmlFor="rsv-visit-at" required>
                <input id="rsv-visit-at" data-testid="rsv-visit-at" type="datetime-local" value={form.visitAt} onChange={(e) => setForm({ ...form, visitAt: e.target.value })} style={inputStyle} />
              </Field>
            </FormRow>
            <FormRow>
              <Field label="呼び出し先種別" htmlFor="rsv-target-type">
                <select id="rsv-target-type" data-testid="rsv-target-type" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value as ReservationTargetType })} style={inputStyle}>
                  <option value="staff">担当者</option>
                  <option value="department">部署</option>
                </select>
              </Field>
              <Field label="呼び出し先 ID" htmlFor="rsv-target-id" required>
                <input id="rsv-target-id" data-testid="rsv-target-id" value={form.targetId} onChange={(e) => setForm({ ...form, targetId: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="利用制約" htmlFor="rsv-usage">
                <select id="rsv-usage" data-testid="rsv-usage" value={form.usagePolicy} onChange={(e) => setForm({ ...form, usagePolicy: e.target.value as ReservationUsagePolicy })} style={inputStyle}>
                  <option value="single_use">1 回利用</option>
                  <option value="same_day">当日内利用</option>
                </select>
              </Field>
            </FormRow>
            <Field label="要件メモ" htmlFor="rsv-note" hint="必要最小限に留めてください（保存期間後に破棄されます）。">
              <input id="rsv-note" data-testid="rsv-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={inputStyle} />
            </Field>
            <div>
              <Button variant="primary" data-testid="rsv-create" onClick={create} disabled={busy}>
                予約を作成
              </Button>
            </div>
          </div>
        </Card>
      </Section>

      {error ? (
        <div data-testid="reservation-error" role="alert" style={{ color: color.danger, fontSize: '0.9rem' }}>
          {error}
        </div>
      ) : null}

      <Section title="予約一覧" description="予定日時の近い順に表示します。">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyMessage="この拠点の来訪予約はまだありません。"
          testId="reservation-table"
        />
      </Section>

      {qrFor ? (
        <QrPanel
          dataUrl={qrFor.dataUrl}
          fileName={qrFileName(qrFor.id)}
          onClose={() => setQrFor(null)}
        />
      ) : null}
    </div>
  );
}

function RowActions({
  reservation,
  onShowQr,
  onCancel,
  onRevoke,
  onReissue,
  busy,
}: {
  reservation: VisitReservation;
  onShowQr: (r: VisitReservation) => void;
  onCancel: (r: VisitReservation) => void;
  onRevoke: (r: VisitReservation) => void;
  onReissue: (r: VisitReservation) => void;
  busy: boolean;
}) {
  const actions = availableActions(reservation.status);
  return (
    <div style={{ display: 'inline-flex', gap: space.xs, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {actions.canShowQr ? (
        <Button data-testid="rsv-qr" onClick={() => onShowQr(reservation)}>
          QR
        </Button>
      ) : null}
      {actions.canReissue ? (
        <Button data-testid="rsv-reissue" onClick={() => onReissue(reservation)} disabled={busy}>
          再発行
        </Button>
      ) : null}
      {actions.canRevoke ? (
        <Button variant="danger" data-testid="rsv-revoke" onClick={() => onRevoke(reservation)} disabled={busy}>
          失効
        </Button>
      ) : null}
      {actions.canCancel ? (
        <Button variant="danger" data-testid="rsv-cancel" onClick={() => onCancel(reservation)} disabled={busy}>
          取消
        </Button>
      ) : null}
    </div>
  );
}

function QrPanel({ dataUrl, fileName, onClose }: { dataUrl: string; fileName: string; onClose: () => void }) {
  return (
    <Section title="予約 QR" description="この QR には個人情報は含まれず、予約参照トークンのみが載っています。">
      <Card testId="reservation-qr-panel">
        <div style={{ display: 'flex', gap: space.lg, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* data URL の SVG を画像として表示。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="reservation-qr-image"
            src={dataUrl}
            alt="来訪予約のチェックイン QR"
            width={180}
            height={180}
            style={{ background: '#fff', borderRadius: radius.sm, padding: space.xs }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
            <a data-testid="reservation-qr-download" href={dataUrl} download={fileName} style={downloadLinkStyle}>
              QR をダウンロード（SVG）
            </a>
            <Button onClick={onClose} data-testid="reservation-qr-close">
              閉じる
            </Button>
          </div>
        </div>
      </Card>
    </Section>
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

const downloadLinkStyle: React.CSSProperties = {
  minHeight: 34,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '6px 12px',
  borderRadius: radius.sm,
  border: '1px solid var(--color-accent)',
  color: 'var(--color-accent)',
  textDecoration: 'none',
  fontWeight: 700,
  fontSize: '0.9rem',
};
