'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceConnectivity, DeviceView } from '@/lib/tenant/device-service';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import type { DeviceKind } from '@/domain/tenant/types';
import {
  Button,
  DataTable,
  Field,
  Section,
  StatusBadge,
  type Column,
  type StatusKind,
} from '@/components/admin/ui';
import { font, space } from '@/components/admin/ui/tokens';
import { renderTextToQrSvg } from '@/lib/reservation/qr';
import { useQueryParams } from './use-query-params';
import { paginate } from './list-io';
import { filterDevices, devicesToCsv, type DeviceListFilter } from './devices-filter';

/**
 * 受付端末（Device）管理 (issue #87, increment 2; 検索/フィルタ/ページング/CSV は #330 item2 残増分)。
 *
 * Tenant > Site > Device のテナント境界に乗せた端末管理。サイトを選び、その配下の
 * 受付端末を一覧・登録・編集（名称/設置場所/種別/メンテ表示）し、有効/無効の切り替えと
 * token 再発行（確認ダイアログ + 監査）を行う。オフラインは最終接続時刻を表示する。
 *
 * 既存 kiosks 管理（#18 / KiosksManager）は書き換えず、Device/kiosk 統合の本対応は
 * 次増分（docs/site-device-management-design.md §Device/Kiosk 統合方針）。
 *
 * 検索/フィルタ/ページ状態は監査ログ・受付履歴と同じく URL クエリを真実源にする（issue #94）。
 *
 * セキュリティ: token の平文は UI に出さない（登録済みの真偽のみ表示）。CSV にも token 平文は
 * 出力しない（`devices-filter.ts` 参照）。
 * actor 解決は現状 developer 相当（#80 写像が未配線）。複数テナント所属時の Tenant 切替 UI は
 * 次増分。inc2 は単一テナント運用の互換シード `internal` を既定テナントとして扱う。
 */
const DEFAULT_TENANT_ID = 'internal';
const PAGE_SIZE = 20;

const KIND_LABEL: Record<DeviceKind, string> = {
  kiosk: '据置端末',
  tablet: 'タブレット',
  desktop: 'デスクトップ',
};

/** 稼働状態 → 共有 StatusBadge の語彙。 */
const CONNECTIVITY_BADGE: Record<DeviceConnectivity, { status: StatusKind; label: string }> = {
  online: { status: 'ok', label: 'オンライン' },
  offline: { status: 'warning', label: 'オフライン' },
  maintenance: { status: 'maintenance', label: 'メンテナンス中' },
  disabled: { status: 'stopped', label: '無効' },
};

function formatLastSeen(iso: string | undefined): string {
  if (!iso) return '未接続';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未接続';
  return d.toLocaleString('ja-JP');
}

export function DevicesManager({ tenantId = DEFAULT_TENANT_ID }: { tenantId?: string }) {
  const [sites, setSites] = useState<SiteWithDevices[]>([]);
  const [siteId, setSiteId] = useState<string>('');
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [kind, setKind] = useState<DeviceKind>('kiosk');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editLocation, setEditLocation] = useState('');
  /** 受付URL発行の確認対象（null=ダイアログ非表示）。 */
  const [reissueTarget, setReissueTarget] = useState<DeviceView | null>(null);
  /** 発行結果（URL+QR を一度だけ表示。閉じると再表示不可）。 */
  const [issued, setIssued] = useState<{ deviceName: string; url: string; expiresAt: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  /** 発行失敗時のメッセージ（null=非表示）。無反応を避けるため必ず表示する。 */
  const [issueError, setIssueError] = useState<string | null>(null);

  const { get, setMany } = useQueryParams();
  const keyword = get('q');
  const connectivityFilter = get('connectivity');
  const kindFilter = get('kind');
  const pageParam = get('page');

  const loadSites = useCallback(async () => {
    const res = await fetch(`/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`);
    if (!res.ok) return;
    const list = (await res.json()) as SiteWithDevices[];
    setSites(list);
    setSiteId((prev) => prev || list[0]?.id || '');
  }, [tenantId]);

  const loadDevices = useCallback(async () => {
    if (!siteId) {
      setDevices([]);
      return;
    }
    const res = await fetch(
      `/api/admin/devices?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    );
    if (res.ok) setDevices((await res.json()) as DeviceView[]);
  }, [tenantId, siteId]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);
  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const add = useCallback(async () => {
    if (name.trim() === '' || siteId === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, siteId, name, location, kind }),
      });
      setName('');
      setLocation('');
      setKind('kiosk');
      await loadDevices();
    } finally {
      setBusy(false);
    }
  }, [name, location, kind, siteId, busy, tenantId, loadDevices]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/devices/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, ...body }),
      });
      await loadDevices();
    },
    [tenantId, loadDevices],
  );

  const toggleEnabled = useCallback(
    (d: DeviceView) => patch(d.id, { enabled: d.status !== 'active' }),
    [patch],
  );
  const toggleMaintenance = useCallback(
    (d: DeviceView) => patch(d.id, { maintenance: !d.maintenance }),
    [patch],
  );

  const saveEdit = useCallback(
    async (id: string) => {
      if (editName.trim() === '') return;
      await patch(id, { name: editName, location: editLocation });
      setEditingId(null);
    },
    [editName, editLocation, patch],
  );

  const confirmReissue = useCallback(async () => {
    if (!reissueTarget) return;
    const target = reissueTarget;
    setReissueTarget(null);
    setIssueError(null);
    try {
      const res = await fetch(`/api/admin/devices/${target.id}/reissue-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { enrollmentUrl: string; expiresAt: string };
        setCopied(false);
        setIssued({ deviceName: target.name, url: data.enrollmentUrl, expiresAt: data.expiresAt });
      } else {
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        setIssueError(
          `受付URLの発行に失敗しました（${res.status}）。${detail?.message ?? '権限・接続を確認してください。'}`,
        );
      }
    } catch {
      setIssueError('受付URLの発行に失敗しました（通信エラー）。接続を確認して再試行してください。');
    }
    await loadDevices();
  }, [reissueTarget, tenantId, loadDevices]);

  const copyUrl = useCallback(async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [issued]);

  const filter: DeviceListFilter = useMemo(
    () => ({
      keyword: keyword || undefined,
      connectivity: (connectivityFilter as DeviceConnectivity) || undefined,
      kind: (kindFilter as DeviceKind) || undefined,
    }),
    [keyword, connectivityFilter, kindFilter],
  );
  const filtered = useMemo(() => filterDevices(devices, filter), [devices, filter]);
  const paged = useMemo(() => paginate(filtered, Number(pageParam) || 1, PAGE_SIZE), [filtered, pageParam]);
  const hasFilter = Boolean(keyword || connectivityFilter || kindFilter);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });

  const downloadCsv = () => {
    const csv = devicesToCsv(filtered);
    // Excel（Windows/日本語ロケール）で文字化けしないよう UTF-8 BOM を付与する。
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `devices-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo<Column<DeviceView>[]>(
    () => [
      {
        key: 'name',
        header: '端末名',
        cell: (d) =>
          editingId === d.id ? (
            <input
              data-testid="device-edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={inputStyle}
            />
          ) : (
            <span data-testid="device-name">{d.name}</span>
          ),
      },
      {
        key: 'location',
        header: '設置場所',
        cell: (d) =>
          editingId === d.id ? (
            <input
              data-testid="device-edit-location"
              value={editLocation}
              onChange={(e) => setEditLocation(e.target.value)}
              style={inputStyle}
            />
          ) : (
            (d.location ?? '—')
          ),
      },
      { key: 'kind', header: '種別', cell: (d) => KIND_LABEL[d.kind ?? 'kiosk'] },
      {
        key: 'connectivity',
        header: '稼働状態',
        cell: (d) => {
          const meta = CONNECTIVITY_BADGE[d.connectivity];
          return <StatusBadge status={meta.status} label={meta.label} />;
        },
      },
      {
        key: 'lastSeen',
        header: '最終接続',
        cell: (d) => <span data-testid="device-last-seen">{formatLastSeen(d.lastSeenAt)}</span>,
      },
      {
        key: 'token',
        header: 'token',
        cell: (d) => (d.tokenRegistered ? '登録済み' : '未登録'),
      },
      {
        key: 'actions',
        header: '操作',
        cell: (d) => (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {editingId === d.id ? (
              <>
                <Button variant="primary" data-testid="device-save" onClick={() => saveEdit(d.id)}>
                  保存
                </Button>
                <Button onClick={() => setEditingId(null)}>取消</Button>
              </>
            ) : (
              <>
                <Button
                  data-testid="device-edit"
                  onClick={() => {
                    setEditingId(d.id);
                    setEditName(d.name);
                    setEditLocation(d.location ?? '');
                  }}
                >
                  編集
                </Button>
                <Button data-testid="device-maintenance" onClick={() => toggleMaintenance(d)}>
                  {d.maintenance ? 'メンテ解除' : 'メンテ表示'}
                </Button>
                <Button
                  variant="danger"
                  data-testid="device-toggle-enabled"
                  onClick={() => toggleEnabled(d)}
                >
                  {d.status === 'active' ? '無効化' : '有効化'}
                </Button>
                <Button
                  variant="primary"
                  data-testid="device-reissue"
                  onClick={() => setReissueTarget(d)}
                >
                  受付URLを発行
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [editingId, editName, editLocation, saveEdit, toggleEnabled, toggleMaintenance],
  );

  return (
    <Section title="受付端末管理" description="サイトを選択し、その配下の受付端末を管理します。端末トークンの値は表示しません（登録状態のみ）。">
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={labelStyle}>
          <span style={labelText}>サイト</span>
          <select
            data-testid="device-site-select"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            style={inputStyle}
          >
            {sites.length === 0 && <option value="">（サイトがありません）</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={labelStyle}>
          <span style={labelText}>端末名</span>
          <input
            data-testid="device-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelText}>設置場所</span>
          <input
            data-testid="device-location-input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelText}>種別</span>
          <select
            data-testid="device-kind-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as DeviceKind)}
            style={inputStyle}
          >
            {(Object.keys(KIND_LABEL) as DeviceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          data-testid="device-add"
          onClick={add}
          disabled={busy || name.trim() === '' || siteId === ''}
        >
          追加
        </Button>
      </div>

      <div
        data-testid="device-filters"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}
      >
        <Field label="端末名・設置場所で検索" htmlFor="device-filter-keyword">
          <input
            id="device-filter-keyword"
            data-testid="device-filter-keyword"
            value={keyword}
            onChange={(e) => updateFilter({ q: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="稼働状態で絞り込み" htmlFor="device-filter-connectivity">
          <select
            id="device-filter-connectivity"
            data-testid="device-filter-connectivity"
            value={connectivityFilter}
            onChange={(e) => updateFilter({ connectivity: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            <option value="online">オンライン</option>
            <option value="offline">オフライン</option>
            <option value="maintenance">メンテナンス中</option>
            <option value="disabled">無効</option>
          </select>
        </Field>
        <Field label="種別で絞り込み" htmlFor="device-filter-kind">
          <select
            id="device-filter-kind"
            data-testid="device-filter-kind"
            value={kindFilter}
            onChange={(e) => updateFilter({ kind: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {(Object.keys(KIND_LABEL) as DeviceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {hasFilter ? (
          <Button
            variant="secondary"
            onClick={() => setMany({ q: '', connectivity: '', kind: '', page: '' })}
            data-testid="device-filter-reset"
          >
            条件をクリア
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          data-testid="device-csv-export"
        >
          CSV エクスポート
        </Button>
      </div>

      <p data-testid="device-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0, marginBottom: space.sm }}>
        {devices.length} 件中 {filtered.length} 件を表示
      </p>

      <DataTable
        testId="device-table"
        columns={columns}
        rows={paged.items}
        rowKey={(d) => d.id}
        emptyMessage={hasFilter ? '条件に一致する受付端末はありません。' : 'このサイトに登録された受付端末はありません。'}
      />

      {paged.pageCount > 1 ? (
        <div
          data-testid="device-pagination"
          style={{ display: 'flex', gap: space.sm, alignItems: 'center', marginTop: space.sm }}
        >
          <Button
            variant="secondary"
            data-testid="device-page-prev"
            disabled={paged.page <= 1}
            onClick={() => setMany({ page: String(paged.page - 1) })}
          >
            前へ
          </Button>
          <span style={{ fontSize: font.small, opacity: 0.8 }} data-testid="device-page-label">
            {paged.page} / {paged.pageCount} ページ
          </span>
          <Button
            variant="secondary"
            data-testid="device-page-next"
            disabled={paged.page >= paged.pageCount}
            onClick={() => setMany({ page: String(paged.page + 1) })}
          >
            次へ
          </Button>
        </div>
      ) : null}

      {reissueTarget && (
        <div data-testid="device-reissue-dialog" role="dialog" aria-modal="true" style={dialogBackdrop}>
          <div style={dialogBox}>
            <h2 style={{ marginTop: 0 }}>受付URLを発行しますか？</h2>
            <p>
              端末 <strong>{reissueTarget.name}</strong> の受付URL（QR）を発行します。現在有効なURLは無効になり、
              新しいURL/QRから受付画面を開けるようになります。この操作は監査ログに記録されます。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button data-testid="device-reissue-cancel" onClick={() => setReissueTarget(null)}>
                取消
              </Button>
              <Button variant="primary" data-testid="device-reissue-confirm" onClick={confirmReissue}>
                発行する
              </Button>
            </div>
          </div>
        </div>
      )}

      {issueError && (
        <div data-testid="device-issue-error" role="alert" style={dialogBackdrop}>
          <div style={dialogBox}>
            <h2 style={{ marginTop: 0, color: 'var(--color-danger)' }}>発行に失敗しました</h2>
            <p>{issueError}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button data-testid="device-issue-error-close" onClick={() => setIssueError(null)}>
                閉じる
              </Button>
            </div>
          </div>
        </div>
      )}

      {issued && (
        <div data-testid="device-issued-dialog" role="dialog" aria-modal="true" style={dialogBackdrop}>
          <div style={{ ...dialogBox, maxWidth: 520 }}>
            <h2 style={{ marginTop: 0 }}>受付URLを発行しました</h2>
            <p style={{ marginTop: 0 }}>
              端末 <strong>{issued.deviceName}</strong> をこのURL/QRで開くと受付画面が有効になります。
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <div
                data-testid="device-issued-qr"
                aria-hidden="true"
                style={{ background: '#fff', padding: 8, borderRadius: 8, lineHeight: 0 }}
                dangerouslySetInnerHTML={{
                  __html: renderTextToQrSvg(issued.url, { cellSize: 5, ariaLabel: '受付端末エンロールQR' }),
                }}
              />
            </div>
            <label style={labelText}>受付URL</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input
                data-testid="device-issued-url"
                readOnly
                value={issued.url}
                onFocus={(e) => e.currentTarget.select()}
                style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
              />
              <Button data-testid="device-issued-copy" onClick={copyUrl}>
                {copied ? 'コピー済み' : 'コピー'}
              </Button>
            </div>
            <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: 4 }}>
              有効期限: {formatLastSeen(issued.expiresAt)}
            </p>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-warning)', marginTop: 0 }}>
              ⚠ このURL/QRはここでしか表示できません。閉じる前に控えるか受付端末で開いてください。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button data-testid="device-issued-close" onClick={() => setIssued(null)}>
                閉じる
              </Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

const inputStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const labelText: React.CSSProperties = { fontSize: '0.85rem', opacity: 0.8 };
const dialogBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 50,
};
const dialogBox: React.CSSProperties = {
  maxWidth: 440,
  // 縦の低い解像度でも見切れないよう、内部スクロールで収める（発行モーダルは QR で背が高い, M1）。
  maxHeight: '90vh',
  overflowY: 'auto',
  padding: 24,
  borderRadius: 12,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-surface-2)',
  color: 'var(--color-text)',
};
