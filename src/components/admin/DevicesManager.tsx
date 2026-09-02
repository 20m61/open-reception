'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceConnectivity, DeviceView } from '@/lib/tenant/device-service';
import type { DeviceKind } from '@/domain/tenant/types';
import { Button, DataTable, Field, Form, Section, StatusBadge, type Column, type StatusKind } from '@/components/admin/ui';
import { font, space, zIndex } from '@/components/admin/ui/tokens';
import { renderTextToQrSvg } from '@/lib/reservation/qr';
import { useQueryParams } from './use-query-params';
import { useModalDialog } from './useModalDialog';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';
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

export function DevicesManager({
  tenantId = DEFAULT_TENANT_ID,
  siteId: defaultSiteId,
}: {
  tenantId?: string;
  /** サーバ (`resolveDefaultScope`) 由来の既定拠点。URL 未指定時のフォールバック。 */
  siteId: string;
}) {
  /**
   * 表示中の拠点は **URL が真実源** (#421)。拠点別設定画面（営業時間・取次ルート等）と
   * **同じ `useSiteScope`** を使う (#423)。
   *
   * 以前はここだけ `resolveSelectedSiteId`（URL 未指定なら**一覧の先頭**）で、他の 4 画面は
   * `resolveSiteScopeState`（URL 未指定なら**既定拠点**）だった。既定拠点が一覧の先頭でない
   * テナントでは同じ URL でも画面ごとに別の拠点を開き、ヘッダの対象拠点表示（#423）とも
   * 食い違う。**同じ問いには同じ答えを返す**ようにここへ寄せた。
   */
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus, reloadSites } =
    useSiteScope(tenantId, defaultSiteId);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  /** `devices` がどのスコープ（テナント+拠点）の内容か。null = 未取得。 */
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  /** 一覧取得の失敗（null = 失敗していない）。空一覧と区別する。 */
  const [listError, setListError] = useState<string | null>(null);
  /** 行操作（保存等）の失敗メッセージ。 */
  const [rowError, setRowError] = useState<string | null>(null);
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

  /*
    3 つのオーバーレイに focus 管理を与える (#890)。`role="dialog"` を宣言しながら
    autoFocus / trap / Escape / 復帰のどれも無かった —— とくに受付 URL は「再表示できない」。
  */
  const reissueDialogRef = useModalDialog<HTMLDivElement>({
    open: reissueTarget !== null,
    onClose: useCallback(() => setReissueTarget(null), []),
  });
  const issuedDialogRef = useModalDialog<HTMLDivElement>({
    open: issued !== null,
    onClose: useCallback(() => setIssued(null), []),
  });
  const errorDialogRef = useModalDialog<HTMLDivElement>({
    open: issueError !== null,
    onClose: useCallback(() => setIssueError(null), []),
  });
  /** 端末登録の失敗メッセージ。フォームの隣に出す（発行失敗のダイアログとは別物）。 */
  const [addError, setAddError] = useState<string | null>(null);

  const { get, setMany } = useQueryParams();
  const keyword = get('q');
  const connectivityFilter = get('connectivity');
  const kindFilter = get('kind');
  const pageParam = get('page');

  const loadDevices = useCallback(async () => {
    // 拠点が確定するまで取りに行かない。確定前の暫定拠点で投げると、遅れて届いた応答が
    // 別拠点の一覧を上書きし、**表示は A なのに中身は B** になる（#535 レビュー P1 と同型）。
    // **早期 return より前でクリアする。** 後ろに置くと、スコープ未確定へ落ちたときに
    // 旧スコープの赤字が残り、再試行ボタンが「押せるのに何も起きない」状態になる
    // （#552 レビュー P2）。
    setListError(null);
    if (!scopeReady || !siteId) {
      setDevices([]);
      setLoadedScope(null);
      return;
    }
    const startedWith = scopeKey;
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/devices?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
      );
    } catch {
      // **取得できなかったことを状態として持つ。** 握り潰すと表は「この拠点に端末はありません」
      // と**事実と異なる断定**を出したまま、原因も再試行手段も画面に出ない（#552 レビュー P1）。
      if (isCurrentScope(startedWith)) setListError('端末一覧を取得できませんでした（通信エラー）。');
      return;
    }
    if (!isCurrentScope(startedWith)) return;
    if (!res.ok) {
      setListError(`端末一覧を取得できませんでした（${res.status}）。`);
      return;
    }
    setDevices((await res.json()) as DeviceView[]);
    setLoadedScope(startedWith);
    setListError(null);
  }, [tenantId, siteId, scopeReady, scopeKey, isCurrentScope]);

  /**
   * **いま描いている行が、いま選んでいる拠点のものか。**
   *
   * `isCurrentScope` は「古い応答を反映しない」ためのもので、**すでに描かれている行**は
   * 守らない。拠点 A → B へ切り替えると、B の応答が届くまで A の端末行が残り、その間
   * 「受付URLを発行」を押せてしまう。発行は現行 URL を失効させるので、**ヘッダもセレクタも
   * B を指した状態で、A で稼働中の iPad を受付不能にできる**（#552 レビュー P1）。
   * `ReceptionFlowsManager` の `flowsLoaded` と同型の対策をここにも置く。
   */
  const devicesLoaded = loadedScope === scopeKey;

  /**
   * **作成できるか**（POST の body に `siteId` を載せるので、拠点が確定している必要がある）。
   *
   * ここに `devicesLoaded` を含めない。含めると**一覧 GET が 1 回失敗しただけで登録が
   * 永久に無効化**され、壊れた端末を入れ替えて受付URLを発行し直す復旧経路がその場で止まる
   * （#552 レビュー P1。読み取りの失敗で書き込みを殺さない）。
   */
  const canCreate = scopeReady && !sitePending && siteId !== '';

  /**
   * **行を操作できるか**。行は deviceId で対象が一意に決まるので `sitePending` は関係ない。
   * 必要なのは「いま描いている行が現在の拠点のものだ」という保証だけ。
   * ここに `sitePending` を混ぜると、切替中に押した「無効化」が**サイレント no-op**になる
   * （ボタンは押せるのに何も起きない。#552 レビュー P1）。
   */
  const canMutateRows = devicesLoaded;

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // 別の拠点へ移ったら、前の拠点で出した失敗メッセージを残さない（無関係な画面に赤字が残る）。
  useEffect(() => {
    setAddError(null);
    setRowError(null);
  }, [scopeKey]);

  const add = useCallback(async () => {
    // **`scopeReady` を見る**。一覧が届く前の `siteId` は既定拠点の暫定値なので、
    // `?siteId=branch-site` の deep link を開いた直後に登録すると**既定拠点に端末が作られる**
    // （#552 レビュー P1。旧実装は一覧未着で `siteId=''` になり偶然守られていた）。
    // sitePending 中も siteId が古いスナップショットのままなので登録しない。
    if (!canCreate || name.trim() === '' || busy) return;
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch('/api/admin/devices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId, name, location, kind }),
        });
      } catch {
        setAddError('端末を登録できませんでした（通信エラー）。接続を確認して再試行してください。');
        return;
      }
      if (!res.ok) {
        // 失敗しても入力を消してフォームを空にすると、成功と見分けが付かない。
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        setAddError(
          res.status === 401
            ? 'セッションが切れています。ログインし直してから再試行してください。'
            : `端末の登録に失敗しました（${res.status}）。${detail?.message ?? '権限・接続を確認してください。'}`,
        );
        return;
      }
      setAddError(null);
      setName('');
      setLocation('');
      setKind('kiosk');
      await loadDevices();
    } finally {
      setBusy(false);
    }
  }, [canCreate, name, location, kind, siteId, busy, tenantId, loadDevices]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>): Promise<boolean> => {
      // 表示中の行が現在の拠点のものだと確認できるまで行操作を通さない（上の解説）。
      // ボタン側も同じ条件で disabled にしてある（片方だけ止めるとサイレント no-op になる）。
      if (!canMutateRows) return false;
      let res: Response;
      try {
        res = await fetch(`/api/admin/devices/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, ...body }),
        });
      } catch {
        // 通信断。**throw させない** — 呼び出し側の「失敗を必ず言う」が効かなくなる
        // （編集モードが開いたまま無言になる。#552 レビュー P2）。
        return false;
      }
      await loadDevices();
      return res.ok;
    },
    [canMutateRows, tenantId, loadDevices],
  );

  /**
   * 行操作の共通ラッパ。**成否を捨てない** — `saveEdit` にだけ入れた「失敗を必ず言う」を
   * 兄弟の呼び出し元へ写していなかった（#552 レビュー P2。この repo が繰り返している型）。
   */
  const mutateRow = useCallback(
    async (id: string, body: Record<string, unknown>, failure: string) => {
      const ok = await patch(id, body);
      setRowError(ok ? null : failure);
    },
    [patch],
  );

  const toggleEnabled = useCallback(
    (d: DeviceView) =>
      void mutateRow(
        d.id,
        { enabled: d.status !== 'active' },
        `${d.status === 'active' ? '無効化' : '有効化'}できませんでした。接続・権限を確認してください。`,
      ),
    [mutateRow],
  );
  const toggleMaintenance = useCallback(
    (d: DeviceView) =>
      void mutateRow(
        d.id,
        { maintenance: !d.maintenance },
        'メンテナンス表示を切り替えられませんでした。接続・権限を確認してください。',
      ),
    [mutateRow],
  );

  const saveEdit = useCallback(
    async (id: string) => {
      if (editName.trim() === '') return;
      // 失敗しても編集モードを閉じると、保存できていないのに保存できたように見える
      // （表示は再取得で旧値へ戻るが、理由はどこにも出ない。#552 レビュー P2）。
      const ok = await patch(id, { name: editName, location: editLocation });
      if (!ok) {
        setRowError('保存できませんでした。接続・権限を確認して再試行してください。');
        return;
      }
      setRowError(null);
      setEditingId(null);
    },
    [editName, editLocation, patch],
  );

  const confirmReissue = useCallback(async () => {
    if (!reissueTarget) return;
    const target = reissueTarget;
    if (!canMutateRows) {
      // ダイアログを開いたまま無反応にしない（取消しか効かない状態を作らない）。
      setReissueTarget(null);
      setIssueError('対象拠点が確定していないため発行できません。読み込み後に再試行してください。');
      return;
    }
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
  }, [reissueTarget, canMutateRows, tenantId, loadDevices]);

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
  // 別拠点の行を描かない（描くと押せてしまう）。切替中は空表示にする。
  const filtered = useMemo(
    () => filterDevices(devicesLoaded ? devices : [], filter),
    [devicesLoaded, devices, filter],
  );
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
                <Button variant="primary" data-testid="device-save"
                  disabled={!canMutateRows} onClick={() => saveEdit(d.id)}>
                  保存
                </Button>
                <Button onClick={() => setEditingId(null)}>取消</Button>
              </>
            ) : (
              <>
                <Button
                  data-testid="device-edit"
                  disabled={!canMutateRows}
                  onClick={() => {
                    setEditingId(d.id);
                    setEditName(d.name);
                    setEditLocation(d.location ?? '');
                  }}
                >
                  編集
                </Button>
                <Button data-testid="device-maintenance"
                  disabled={!canMutateRows} onClick={() => toggleMaintenance(d)}>
                  {d.maintenance ? 'メンテ解除' : 'メンテ表示'}
                </Button>
                <Button
                  variant="danger"
                  data-testid="device-toggle-enabled"
                  disabled={!canMutateRows}
                  onClick={() => toggleEnabled(d)}
                >
                  {d.status === 'active' ? '無効化' : '有効化'}
                </Button>
                <Button
                  variant="primary"
                  data-testid="device-reissue"
                  disabled={!canMutateRows}
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
    [editingId, editName, editLocation, canMutateRows, saveEdit, toggleEnabled, toggleMaintenance],
  );

  return (
    <Section
      headingLevel="h1"
      title="受付端末管理"
      description="サイトを選択し、その配下の受付端末を管理します。端末トークンの値は表示しません（登録状態のみ）。"
    >
      {/*
        旧 /admin/kiosks はナビから外したので、ここから辿れるようにする (#421)。
        token 登録・失効の旧フローが生きているため画面は残している。
      */}
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 16 }}>
        旧レジストリ（token 登録・失効）の画面は{' '}
        <a href="/admin/kiosks" data-testid="devices-legacy-kiosks-link">
          受付端末管理（旧）
        </a>{' '}
        に残しています。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        {/*
          共有部品へ寄せる (#552 レビュー N1)。ここだけ独自 select だったため、
          (a) 見出しが「サイト」で他 4 画面とヘッダの「対象拠点」と用語がずれ、
          (b) 一覧未取得のとき選択中の拠点があるのに「（サイトがありません）」と出し、
          (c) 切替中（`sitePending`）に disabled にならない、の 3 点がずれていた。
        */}
        <SiteScopeSelect
          sites={sites}
          siteId={siteId}
          onSelect={selectSite}
          disabled={sitePending}
          testId="device-site-select"
          status={listStatus}
          onRetry={reloadSites}
        />
      </div>

      <Form
        onSubmit={add}
        aria-label="端末を追加"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}
      >
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
          type="submit"
          data-testid="device-add"
          disabled={busy || name.trim() === '' || !canCreate}
        >
          追加
        </Button>
        {addError === null ? null : (
          <p
            data-testid="device-add-error"
            role="alert"
            style={{ color: 'var(--color-danger)', margin: 0, alignSelf: 'center' }}
          >
            {addError}
          </p>
        )}
      </Form>

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

      {listError === null ? null : (
        <p data-testid="device-list-error" role="alert" style={{ color: 'var(--color-danger)' }}>
          {listError}{' '}
          <Button
            data-testid="device-list-retry"
            disabled={!scopeReady}
            onClick={() => void loadDevices()}
          >
            再試行
          </Button>
        </p>
      )}
      {rowError === null ? null : (
        <p data-testid="device-row-error" role="alert" style={{ color: 'var(--color-danger)' }}>
          {rowError}
        </p>
      )}

      {/* 未確定のときに「0 件中 0 件」と断定しない（0 件と読めてしまう）。 */}
      {devicesLoaded ? (
        <p data-testid="device-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0, marginBottom: space.sm }}>
          {devices.length} 件中 {filtered.length} 件を表示
        </p>
      ) : null}

      <DataTable
        testId="device-table"
        columns={columns}
        rows={paged.items}
        rowKey={(d) => d.id}
        emptyMessage={
          // 失敗の詳細は上のバナーに出しているので、ここでは短く（二重表示にしない）。
          listError !== null
            ? '端末一覧を表示できません。'
            : !devicesLoaded
              ? '読み込み中…'
              : hasFilter
                ? '条件に一致する受付端末はありません。'
                : 'このサイトに登録された受付端末はありません。'
        }
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
        <div
          data-testid="device-reissue-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-reissue-title"
          tabIndex={-1}
          ref={reissueDialogRef}
          style={dialogBackdrop}
        >
          <div style={dialogBox}>
            <h2 id="device-reissue-title" style={{ marginTop: 0 }}>受付URLを発行しますか？</h2>
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
        /*
          `role="alert"` だけだと**ダイアログとして辿れない** (#890 / 課題 15)。
          閉じるまで操作を止めるオーバーレイなので dialog として宣言し、`aria-describedby` で
          本文（失敗理由）を読み上げへ載せる。alert の即時読み上げは `role="alert"` を内側の
          本文へ移して保つ。
        */
        <div
          data-testid="device-issue-error"
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-issue-error-title"
          aria-describedby="device-issue-error-body"
          tabIndex={-1}
          ref={errorDialogRef}
          style={dialogBackdrop}
        >
          <div style={dialogBox}>
            <h2 id="device-issue-error-title" style={{ marginTop: 0, color: 'var(--color-danger)' }}>
              発行に失敗しました
            </h2>
            <p id="device-issue-error-body" role="alert">
              {issueError}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button data-testid="device-issue-error-close" onClick={() => setIssueError(null)}>
                閉じる
              </Button>
            </div>
          </div>
        </div>
      )}

      {issued && (
        <div
          data-testid="device-issued-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-issued-title"
          tabIndex={-1}
          ref={issuedDialogRef}
          style={dialogBackdrop}
        >
          <div style={{ ...dialogBox, maxWidth: 520 }}>
            <h2 id="device-issued-title" style={{ marginTop: 0 }}>受付URLを発行しました</h2>
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
            <p style={{ fontSize: font.small, opacity: 0.8, marginBottom: 4 }}>
              有効期限: {formatLastSeen(issued.expiresAt)}
            </p>
            <p style={{ fontSize: font.small, color: 'var(--color-warning)', marginTop: 0 }}>
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
const labelText: React.CSSProperties = { fontSize: font.small, opacity: 0.8 };
const dialogBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: zIndex.dialog,
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
