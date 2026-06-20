'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StoredReceptionFlow } from '@/lib/reception/flow-config/types';
import { DEFAULT_STEPS, type FlowField, type FlowStepKind } from '@/domain/reception/custom-flow';

/**
 * 来訪目的別カスタム受付フロー管理 (issue #100, increment 1)。
 *
 * テナント/サイト配下のフロー一覧・作成・名称編集・有効/無効・削除を管理 API 経由で行う。
 * 「目的ごとに、受付端末でどのステップを・どの入力項目で表示するか」を非エンジニアでも
 * 把握できるよう、フローごとにステップ並びと入力項目（タイプ・必須）を可視化する。
 * 削除は本番運用に影響するため確認ダイアログを挟む。
 *
 * inc1 のスコープ:
 *   - 作成は目的キー・表示名・説明で行い、ステップは標準並び（DEFAULT_STEPS）を初期値とする。
 *     ステップ取捨選択・入力項目の編集フォームは API では可能（次増分で UI を拡張）。
 *   - 一覧では表示順（order）→ 表示名の安定順で並べる。tenant 切り替え UI は次増分。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default-site';

const STEP_LABELS: Record<FlowStepKind, string> = {
  purpose: '目的選択',
  target: '担当者・部署選択',
  visitorInfo: '来訪者情報入力',
  confirm: '確認',
  call: '呼び出し',
};

const FIELD_TYPE_LABELS: Record<FlowField['type'], string> = {
  text: 'テキスト',
  textarea: '複数行テキスト',
  select: '選択',
  checkbox: 'チェック',
};

export function ReceptionFlowsManager({
  tenantId = DEFAULT_TENANT_ID,
  siteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  siteId?: string;
}) {
  const [items, setItems] = useState<StoredReceptionFlow[]>([]);
  const [purposeKey, setPurposeKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/reception-flows?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as StoredReceptionFlow[];
      setItems(
        [...data].sort((a, b) =>
          a.order !== b.order ? a.order - b.order : a.displayName.localeCompare(b.displayName),
        ),
      );
    }
  }, [tenantId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (purposeKey.trim() === '' || displayName.trim() === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/reception-flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          siteId,
          purposeKey: purposeKey.trim(),
          displayName: displayName.trim(),
          order: items.length,
          steps: DEFAULT_STEPS,
          fields: [],
        }),
      });
      setPurposeKey('');
      setDisplayName('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [purposeKey, displayName, busy, tenantId, siteId, items.length, load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/reception-flows/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, ...body }),
      });
      await load();
    },
    [tenantId, load],
  );

  const toggle = useCallback((f: StoredReceptionFlow) => patch(f.id, { enabled: !f.enabled }), [patch]);

  const saveName = useCallback(
    async (id: string) => {
      if (editName.trim() === '') return;
      await patch(id, { displayName: editName });
      setEditingId(null);
      setEditName('');
    },
    [editName, patch],
  );

  const remove = useCallback(
    async (f: StoredReceptionFlow) => {
      if (!window.confirm(`受付フロー「${f.displayName}」を削除します。よろしいですか?`)) return;
      await fetch(`/api/admin/reception-flows/${f.id}?tenantId=${encodeURIComponent(tenantId)}`, {
        method: 'DELETE',
      });
      await load();
    },
    [tenantId, load],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>受付フロー</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> / 拠点 <code>{siteId}</code> の来訪目的別フローを管理します。
        目的ごとに、受付端末で表示するステップと入力項目を切り替えられます。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>目的キー（英数）</span>
          <input
            data-testid="flow-key-input"
            value={purposeKey}
            onChange={(e) => setPurposeKey(e.target.value)}
            placeholder="interview"
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>表示名</span>
          <input
            data-testid="flow-name-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="面接・採用候補者"
            style={inputStyle}
          />
        </label>
        <button
          type="button"
          data-testid="flow-add"
          onClick={add}
          disabled={busy || purposeKey.trim() === '' || displayName.trim() === ''}
          style={btnStyle}
        >
          追加
        </button>
      </div>

      <div data-testid="flow-list" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((f) => (
          <article
            key={f.id}
            data-testid="flow-card"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              padding: 16,
              background: 'var(--color-surface)',
            }}
          >
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {editingId === f.id ? (
                <input
                  data-testid="flow-edit-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={inputStyle}
                />
              ) : (
                <strong data-testid="flow-name" style={{ fontSize: '1.05rem' }}>
                  {f.displayName}
                </strong>
              )}
              <code style={{ fontSize: '0.8rem', opacity: 0.6 }}>{f.purposeKey}</code>
              <span
                data-testid="flow-status"
                style={{
                  fontSize: '0.8rem',
                  color: f.enabled ? 'var(--color-success)' : 'var(--color-muted)',
                }}
              >
                {f.enabled ? '有効' : '無効'}
              </span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {editingId === f.id ? (
                  <>
                    <button type="button" data-testid="flow-save" onClick={() => saveName(f.id)} style={smallBtn}>
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} style={smallBtn}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid="flow-edit"
                      onClick={() => {
                        setEditingId(f.id);
                        setEditName(f.displayName);
                      }}
                      style={smallBtn}
                    >
                      名称編集
                    </button>
                    <button type="button" data-testid="flow-toggle" onClick={() => toggle(f)} style={smallBtn}>
                      {f.enabled ? '無効化' : '有効化'}
                    </button>
                    <button type="button" data-testid="flow-delete" onClick={() => remove(f)} style={dangerBtn}>
                      削除
                    </button>
                  </>
                )}
              </div>
            </header>

            {f.description ? (
              <p style={{ opacity: 0.75, fontSize: '0.9rem', margin: '8px 0 0' }}>{f.description}</p>
            ) : null}

            <FlowSummary steps={f.steps} fields={f.fields} />
          </article>
        ))}
      </div>
    </section>
  );
}

/** フローのステップ並びと入力項目を可視化する。 */
function FlowSummary({ steps, fields }: { steps: FlowStepKind[]; fields: FlowField[] }) {
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div data-testid="flow-steps">
        <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 4 }}>ステップ</div>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', gap: 12, flexWrap: 'wrap', listStyle: 'decimal' }}>
          {steps.map((s, i) => (
            <li key={`${s}-${i}`} style={{ fontSize: '0.9rem' }}>
              {STEP_LABELS[s]}
            </li>
          ))}
        </ol>
      </div>
      <div data-testid="flow-fields">
        <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 4 }}>入力項目</div>
        {fields.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: '0.85rem', margin: 0 }}>入力項目はありません。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {fields.map((field) => (
              <li key={field.key} data-testid="flow-field" style={{ fontSize: '0.9rem' }}>
                <span>{field.label}</span>{' '}
                <span style={{ opacity: 0.7 }}>
                  （{FIELD_TYPE_LABELS[field.type]}
                  {field.required ? ' / 必須' : ''}）
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
const btnStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 16px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-accent)',
  color: '#0f172a',
  fontWeight: 700,
  cursor: 'pointer',
};
const smallBtn: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  ...smallBtn,
  borderColor: 'rgba(248,113,113,0.5)',
  color: 'var(--color-danger, #f87171)',
};
