'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StoredReceptionFlow } from '@/lib/reception/flow-config/types';
import {
  DEFAULT_STEPS,
  FIELD_TYPES,
  type FieldType,
  type FlowField,
  type FlowStepKind,
} from '@/domain/reception/custom-flow';
import { Button, Card, Field } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import {
  buildFieldDraft,
  isFieldFormReady,
  reorderBySwap,
  type FieldFormInput,
} from './reception-flow-edit';

/**
 * 来訪目的別カスタム受付フロー管理 (issue #100, increment 1)。
 *
 * テナント/サイト配下のフロー一覧・作成・名称編集・有効/無効・削除を管理 API 経由で行う。
 * 「目的ごとに、受付端末でどのステップを・どの入力項目で表示するか」を非エンジニアでも
 * 把握できるよう、フローごとにステップ並びと入力項目（タイプ・必須）を可視化する。
 * 削除は本番運用に影響するため確認ダイアログを挟む。
 *
 * スコープ:
 *   - inc1: 作成（目的キー・表示名）・名称編集・有効/無効・削除。ステップは標準並びを初期値。
 *   - inc2: 並び替え（order を上/下で入れ替え）と入力項目（text/textarea/select/checkbox）の
 *     追加・削除 UI を追加。検証はドメイン/API、UI 整形は reception-flow-edit.ts の純関数に委ねる。
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

  // 並び替え (inc2): 隣と order を入れ替え、変わった項目だけ PATCH してから一度だけ再読込する。
  const reorder = useCallback(
    async (index: number, dir: -1 | 1) => {
      const { changed } = reorderBySwap(items, index, dir);
      if (changed.length === 0) return;
      await Promise.all(
        changed.map((c) =>
          fetch(`/api/admin/reception-flows/${c.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tenantId, order: c.order }),
          }),
        ),
      );
      await load();
    },
    [items, tenantId, load],
  );

  // 入力項目の保存 (inc2): fields 配列ごと PATCH する（検証は API のドメイン層）。
  const saveFields = useCallback(
    (id: string, fields: FlowField[]) => patch(id, { fields }),
    [patch],
  );

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

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}>
        <Field label="目的キー（英数）" htmlFor="flow-key-input">
          <input
            id="flow-key-input"
            data-testid="flow-key-input"
            value={purposeKey}
            onChange={(e) => setPurposeKey(e.target.value)}
            placeholder="interview"
            style={inputStyle}
          />
        </Field>
        <Field label="表示名" htmlFor="flow-name-input">
          <input
            id="flow-name-input"
            data-testid="flow-name-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="面接・採用候補者"
            style={inputStyle}
          />
        </Field>
        <Button
          variant="primary"
          data-testid="flow-add"
          onClick={add}
          disabled={busy || purposeKey.trim() === '' || displayName.trim() === ''}
        >
          追加
        </Button>
      </div>

      <div data-testid="flow-list" style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        {items.map((f, index) => (
          <Card key={f.id} testId="flow-card">
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
                  color: f.enabled ? color.success : color.muted,
                }}
              >
                {f.enabled ? '有効' : '無効'}
              </span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {editingId === f.id ? (
                  <>
                    <Button data-testid="flow-save" onClick={() => saveName(f.id)}>
                      保存
                    </Button>
                    <Button onClick={() => setEditingId(null)}>取消</Button>
                  </>
                ) : (
                  <>
                    <Button
                      data-testid="flow-move-up"
                      onClick={() => reorder(index, -1)}
                      disabled={index === 0}
                      aria-label={`${f.displayName}を上へ`}
                    >
                      ↑
                    </Button>
                    <Button
                      data-testid="flow-move-down"
                      onClick={() => reorder(index, 1)}
                      disabled={index === items.length - 1}
                      aria-label={`${f.displayName}を下へ`}
                    >
                      ↓
                    </Button>
                    <Button
                      data-testid="flow-edit"
                      onClick={() => {
                        setEditingId(f.id);
                        setEditName(f.displayName);
                      }}
                    >
                      名称編集
                    </Button>
                    <Button data-testid="flow-toggle" onClick={() => toggle(f)}>
                      {f.enabled ? '無効化' : '有効化'}
                    </Button>
                    <Button variant="danger" data-testid="flow-delete" onClick={() => remove(f)}>
                      削除
                    </Button>
                  </>
                )}
              </div>
            </header>

            {f.description ? (
              <p style={{ opacity: 0.75, fontSize: '0.9rem', margin: '8px 0 0' }}>{f.description}</p>
            ) : null}

            <FlowSummary steps={f.steps} />
            <FlowFieldsEditor
              fields={f.fields}
              onSave={(fields) => saveFields(f.id, fields)}
            />
          </Card>
        ))}
      </div>
    </section>
  );
}

/** フローのステップ並びを可視化する（読み取り専用）。 */
function FlowSummary({ steps }: { steps: FlowStepKind[] }) {
  return (
    <div style={{ marginTop: 12 }}>
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
    </div>
  );
}

const EMPTY_FIELD_FORM: FieldFormInput = {
  key: '',
  label: '',
  type: 'text',
  required: false,
  optionsInput: '',
};

/**
 * 入力項目（visitorInfo フィールド）の追加・削除エディタ (issue #100 inc2)。
 * 既存項目を一覧し、削除と追加ができる。整形は reception-flow-edit.ts の純関数、
 * 検証は API のドメイン層（validateFields）が担う。onSave は fields 配列ごと保存する。
 */
function FlowFieldsEditor({
  fields,
  onSave,
}: {
  fields: FlowField[];
  onSave: (fields: FlowField[]) => void;
}) {
  const [form, setForm] = useState<FieldFormInput>(EMPTY_FIELD_FORM);

  const addField = () => {
    if (!isFieldFormReady(form)) return;
    onSave([...fields, buildFieldDraft(form)]);
    setForm(EMPTY_FIELD_FORM);
  };

  const removeField = (key: string) => onSave(fields.filter((f) => f.key !== key));

  return (
    <div data-testid="flow-fields" style={{ marginTop: 12 }}>
      <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 4 }}>入力項目</div>
      {fields.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem', margin: '0 0 8px' }}>入力項目はありません。</p>
      ) : (
        <ul style={{ margin: '0 0 8px', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {fields.map((field) => (
            <li
              key={field.key}
              data-testid="flow-field"
              style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span>{field.label}</span>
              <span style={{ opacity: 0.7 }}>
                （{FIELD_TYPE_LABELS[field.type]}
                {field.required ? ' / 必須' : ''}）
              </span>
              <Button
                data-testid="flow-field-remove"
                onClick={() => removeField(field.key)}
                aria-label={`${field.label}を削除`}
                style={{ marginLeft: 'auto' }}
              >
                削除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="項目キー（英数）" htmlFor={`field-key-${fields.length}`}>
          <input
            data-testid="flow-field-key"
            value={form.key}
            onChange={(e) => setForm((s) => ({ ...s, key: e.target.value }))}
            placeholder="slot"
            style={inputStyle}
          />
        </Field>
        <Field label="ラベル" htmlFor={`field-label-${fields.length}`}>
          <input
            data-testid="flow-field-label"
            value={form.label}
            onChange={(e) => setForm((s) => ({ ...s, label: e.target.value }))}
            placeholder="希望枠"
            style={inputStyle}
          />
        </Field>
        <Field label="種別" htmlFor={`field-type-${fields.length}`}>
          <select
            data-testid="flow-field-type"
            value={form.type}
            onChange={(e) => setForm((s) => ({ ...s, type: e.target.value as FieldType }))}
            style={inputStyle}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {form.type === 'select' ? (
          <Field label="選択肢（カンマ区切り）" htmlFor={`field-options-${fields.length}`}>
            <input
              data-testid="flow-field-options"
              value={form.optionsInput}
              onChange={(e) => setForm((s) => ({ ...s, optionsInput: e.target.value }))}
              placeholder="午前, 午後"
              style={inputStyle}
            />
          </Field>
        ) : null}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', minHeight: 44 }}>
          <input
            type="checkbox"
            data-testid="flow-field-required"
            checked={form.required}
            onChange={(e) => setForm((s) => ({ ...s, required: e.target.checked }))}
          />
          必須
        </label>
        <Button data-testid="flow-field-add" onClick={addField} disabled={!isFieldFormReady(form)}>
          項目を追加
        </Button>
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
