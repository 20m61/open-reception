'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OrganizationUnit } from '@/domain/organization/types';
import { organizationVisibility } from '@/domain/organization/visibility';
import { Button, DataTable, Pager, Section, StatusBadge, type Column } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import { useQueryParams } from './use-query-params';
import { useTableSort } from './use-table-sort';
import { paginate, sortRows } from './list-io';

/**
 * 階層組織の管理 (#373 増分 6)。
 *
 * ## 何のための画面か
 *
 * 既存の「部署管理」は**内部の組織そのもの**を作る画面。ここは、その組織を
 * **来訪者にどう見せるか**を決める画面。分ける理由は、内部の正式名称と来訪者向けの
 * 表示名が一致しないため（`株式会社サンプル 営業本部` を来訪者に見せたくはない）。
 *
 * ## 「見えない理由」を必ず出す
 *
 * 運用者にとって最も分かりにくい失敗は「保存したのに来訪者画面に出ない」。
 * 無効なのか、非公開なのか、公開表示名が空なのかで直し方が違う。判定は
 * `organizationVisibility` に一本化してあり、**来訪者向けの絞り込みと同じ関数**を使う
 * （別々に書くと、この画面が「見える」と言っているのに出ない、が起きる）。
 *
 * 無効化（`enabled`）はここから触らない。既存の部署管理と AND で合成されるので、
 * 二箇所から閉じられると運用者がどちらを見ればよいか分からなくなる。閉じるのは部署管理、
 * 来訪者への出し方はここ、と役割を分ける。
 */

/**
 * `id` の子孫 id 集合。上位組織の候補から外すために使う。
 *
 * サーバ側（`canSetParent`）が最終判定を持つので、ここは **UI の親切**に過ぎない。
 * それでも出さないのは、選べてしまうと運用者が「なぜ保存できないのか」を考える羽目になるため。
 */
function descendantIds(units: ReadonlyArray<OrganizationUnit>, id: string): Set<string> {
  const found = new Set<string>();
  let frontier = [id];
  while (frontier.length > 0) {
    const children = units.filter((u) => u.parentId !== undefined && frontier.includes(u.parentId));
    frontier = children.map((c) => c.id).filter((c) => !found.has(c));
    frontier.forEach((c) => found.add(c));
  }
  return found;
}

const HIDDEN_REASON_LABEL: Record<
  Extract<ReturnType<typeof organizationVisibility>, { kind: 'hidden' }>['reason'],
  string
> = {
  disabled: '部署管理で無効',
  'not-public': '来訪者に出さない設定',
  'no-public-name': '公開表示名が空',
};

const PAGE_SIZE = 20;

export function OrganizationsManager() {
  /*
   * 🔴 **「まだ読めていない」と「0 件だった」を型で分ける (#966 AC2)。**
   * 初期値が `[]` だと、取得前も取得失敗も「組織がありません」と**断定**し、
   * 運用者を「まず部署管理で追加してください」へ誘導してしまう。
   */
  const [items, setItems] = useState<OrganizationUnit[] | null>(null);
  const { get, setMany } = useQueryParams();
  const { sort, setSort } = useTableSort();
  const [unresolvedStaffIds, setUnresolvedStaffIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 一覧の読み取り失敗。**`DataTable` の `failed` を決めるのはこれだけ**。 */
  const [listError, setListError] = useState<string | null>(null);
  /*
   * 保存（PATCH）の失敗 (#968 AC4 と同じ理由で読み取りと分ける)。同じ state に載せると、
   * 保存に失敗しただけで一覧が「読み込めませんでした」へ落ちる —— 読めているのに
   * 読めていないと言うことになる。
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/organizations');
      if (!res.ok) {
        setListError('組織一覧を取得できませんでした');
        return;
      }
      const body = (await res.json()) as {
        items: OrganizationUnit[];
        unresolvedStaffIds: string[];
      };
      setItems(body.items);
      setUnresolvedStaffIds(body.unresolvedStaffIds);
      setListError(null);
      setDrafts({});
    } catch {
      // 通信そのものの失敗も「失敗」へ落とす (#966 AC3)。
      setListError('組織一覧を取得できませんでした');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      setSaveError(null);
      try {
        const res = await fetch(`/api/admin/organizations/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // **失敗を黙って飲まない。** 保存できていないのに一覧が変わらないだけだと、
          // 運用者は「反映が遅いのか」と待ってしまう。
          const detail = (await res.json().catch(() => null)) as { message?: string } | null;
          setSaveError(detail?.message ?? '保存できませんでした');
          return;
        }
        setSaveError(null);
        await load();
      } catch {
        // 送信そのものが失敗したときも黙らない（押しても何も起きない、を作らない）。
        setSaveError('保存できませんでした。通信を確認してください。');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const columns: Column<OrganizationUnit>[] = [
    {
      key: 'official',
      header: '内部の名称',
      sortValue: (u) => u.officialName,
      cell: (u) => <span style={{ color: color.muted }}>{u.officialName}</span>,
    },
    {
      key: 'public',
      header: '来訪者に見せる名称',
      cell: (u) => {
        const draft = drafts[u.id] ?? u.publicDisplayName;
        const changed = draft !== u.publicDisplayName;
        return (
          <span style={{ display: 'inline-flex', gap: space.sm, alignItems: 'center' }}>
            <input
              data-testid={`org-public-name-${u.id}`}
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [u.id]: e.target.value }))}
              style={{ minWidth: '12rem' }}
            />
            {changed ? (
              <Button
                data-testid={`org-save-${u.id}`}
                disabled={busyId === u.id}
                onClick={() => void patch(u.id, { publicDisplayName: draft })}
              >
                保存
              </Button>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'parent',
      header: '上位組織',
      cell: (u) => (
        // 自分と自分の子孫は選ばせない（循環になる）。サーバも `canSetParent` で拒否するが、
        // **選べてしまう UI は運用者に「なぜ保存できないのか」を考えさせる**ので出さない。
        <select
          data-testid={`org-parent-${u.id}`}
          value={u.parentId ?? ''}
          disabled={busyId === u.id}
          onChange={(e) => void patch(u.id, { parentId: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">（トップレベル）</option>
          {(items ?? [])
            .filter(
              (candidate) => candidate.id !== u.id && !descendantIds(items ?? [], u.id).has(candidate.id),
            )
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.publicDisplayName}
              </option>
            ))}
        </select>
      ),
    },
    {
      key: 'visibility',
      header: '来訪者から',
      cell: (u) => {
        const visibility = organizationVisibility(u);
        return visibility.kind === 'visible' ? (
          <span data-testid={`org-visible-${u.id}`}>
            <StatusBadge status="ok" label="見える" />
          </span>
        ) : (
          // 「出ない」だけでなく**理由**を出す。直す場所が分からないと設定を触り回すことになる。
          <span data-testid={`org-hidden-${u.id}`}>
            <StatusBadge
              status="warning"
              label={`見えない（${HIDDEN_REASON_LABEL[visibility.reason]}）`}
            />
          </span>
        );
      },
    },
    {
      key: 'toggle',
      header: '来訪者に出す',
      cell: (u) => (
        <Button
          data-testid={`org-toggle-public-${u.id}`}
          disabled={busyId === u.id}
          onClick={() => void patch(u.id, { publicInDirectory: !u.publicInDirectory })}
        >
          {u.publicInDirectory ? '出さない' : '出す'}
        </Button>
      ),
    },
    {
      key: 'order',
      header: '表示順',
      align: 'right',
      cell: (u) => (
        <span style={{ display: 'inline-flex', gap: space.xs }}>
          <Button
            data-testid={`org-up-${u.id}`}
            disabled={busyId === u.id}
            onClick={() => void patch(u.id, { displayOrder: u.displayOrder - 1 })}
          >
            ↑
          </Button>
          <Button
            data-testid={`org-down-${u.id}`}
            disabled={busyId === u.id}
            onClick={() => void patch(u.id, { displayOrder: u.displayOrder + 1 })}
          >
            ↓
          </Button>
        </span>
      ),
    },
  ];

  const sorted = sortRows(items ?? [], columns, sort);
  const paged = paginate(sorted, Number(get('page')) || 1, PAGE_SIZE);

  return (
    <Section headingLevel="h1" title="組織（来訪者への見せ方）">
      <p style={{ color: color.muted }}>
        部署そのものの追加・無効化は「部署管理」で行います。ここでは、来訪者の受付端末に
        <strong>どの名前で・どの順で出すか</strong>を決めます。
      </p>

      {listError === null ? null : (
        <p role="alert" data-testid="org-error" style={{ color: color.danger }}>
          {listError}
        </p>
      )}
      {saveError === null ? null : (
        <p role="alert" data-testid="org-save-error" style={{ color: color.danger }}>
          {saveError}
        </p>
      )}

      {/*
        部署に紐づかない担当者は**黙って捨てない**。移行漏れの信号で、放置すると
        来訪者から呼べない担当者が静かに生まれる。
      */}
      {unresolvedStaffIds.length === 0 ? null : (
        <p data-testid="org-unresolved" style={{ color: color.warning }}>
          {`どの組織にも属していない担当者が ${unresolvedStaffIds.length} 名います。受付端末から呼び出せない可能性があります。`}
        </p>
      )}

      {/*
        🔴 **表の外で 0 件を断定しない (#966 AC1)。** ここは `items.length === 0` で
        「組織がありません」を出していたが、**取得前も取得失敗も長さ 0** なので、
        読めていないことを「無い」と言い換えていた。3 状態の判断は `DataTable` が
        `resolveAdminReadState` へ委ねるので、画面ごとに再実装しない。
      */}
      <DataTable
        testId="org-table"
        rows={paged.items}
        columns={columns}
        rowKey={(u) => u.id}
        sort={sort}
        onSortChange={setSort}
        loaded={items !== null}
        failed={listError !== null}
        emptyTitle="組織がありません"
        emptyMessage="まず「部署管理」で部署を追加してください。"
        failureMessage="組織一覧を読み込めませんでした。"
        scrollRegionLabel="組織一覧"
      />
      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        onChange={(next) => setMany({ page: String(next) })}
        testIdPrefix="org"
      />
    </Section>
  );
}
