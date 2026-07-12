'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SIGNAGE_CONTENT_TYPES,
  type SignageConfig,
  type SignageContentType,
  type SignageItem,
} from '@/domain/signage/types';
import { Button, Field, FormRow, SaveFeedback, Section, useSaveFeedback } from '@/components/admin/ui';
import { color, radius, space } from '@/components/admin/ui/tokens';

/**
 * 待機中サイネージ 管理画面 (issue #101, increment 1)。
 *
 * inc1 のサイネージ API（/api/admin/signage）を介して、サイトの待機画面に出す
 * コンテンツ（時計/案内文/画像/スライド）と表示間隔・有効状態を編集する。
 *
 * 表示するコンテンツに来訪者の PII を含めない。画像/スライドの外部 URL は信頼できる
 * オリジンのみ（サーバ側 rotation.validateConfig が http(s) を強制）。素材ライセンスは
 * #105 に従う（docs/signage-mode-design.md）。
 *
 * actor の実テナント解決は #80 配線に依存する。inc1 は単一テナント運用の互換シード
 * `internal` を既定にし、siteId は画面上部で選択（暫定は手入力 + 既定値）する。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default';

const TYPE_LABEL: Record<SignageContentType, string> = {
  clock: '時計',
  message: '案内文',
  image: '画像',
  slides: 'スライド',
};

function newItem(): SignageItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'clock',
    enabled: true,
  } as SignageItem;
}

type FieldError = { field: string; message: string };

export function SignageManager({
  tenantId = DEFAULT_TENANT_ID,
  initialSiteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  initialSiteId?: string;
}) {
  const [siteId, setSiteId] = useState(initialSiteId);
  const [config, setConfig] = useState<SignageConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const { feedback, success, failure, clear } = useSaveFeedback();

  const scopeQuery = useMemo(
    () => `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    [tenantId, siteId],
  );

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/admin/signage?${scopeQuery}`);
    if (res.ok) {
      setConfig((await res.json()) as SignageConfig);
    } else {
      setError('読み込みに失敗しました');
    }
  }, [scopeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((patch: Partial<SignageConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<SignageItem>) => {
    setConfig((c) =>
      c ? { ...c, items: c.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) } : c,
    );
  }, []);

  const addItem = useCallback(() => {
    setConfig((c) => (c ? { ...c, items: [...c.items, newItem()] } : c));
  }, []);

  const removeItem = useCallback((id: string) => {
    setConfig((c) => (c ? { ...c, items: c.items.filter((it) => it.id !== id) } : c));
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    clear();
    const res = await fetch('/api/admin/signage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        siteId,
        enabled: config.enabled,
        defaultIntervalSeconds: config.defaultIntervalSeconds,
        items: config.items,
      }),
    });
    if (res.ok) {
      setConfig((await res.json()) as SignageConfig);
      success(`保存しました（${new Date().toLocaleTimeString()}）`);
    } else {
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        fields?: FieldError[];
      };
      failure(data.message ?? '保存に失敗しました。');
      setFieldErrors(data.fields ?? []);
    }
    setBusy(false);
  }, [config, tenantId, siteId, success, failure, clear]);

  const errorFor = useCallback(
    (field: string) => fieldErrors.find((e) => e.field === field)?.message,
    [fieldErrors],
  );

  return (
    <Section
      title="待機中サイネージ"
      description="受付待機中に表示するコンテンツ（時計 / 案内文 / 画像 / スライド）を設定します。来訪者の個人情報は表示しません。画像・スライドの外部 URL は信頼できるオリジンのみを使用し、素材のライセンスを確認してください。"
      actions={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !config}>
          保存
        </Button>
      }
    >
      <FormRow>
        <Field label="サイト ID" htmlFor="signage-site">
          <input
            id="signage-site"
            data-testid="signage-site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </FormRow>

      {error ? (
        <p data-testid="signage-error" style={{ color: color.danger }}>
          {error}
        </p>
      ) : null}
      <SaveFeedback feedback={feedback} successTestId="signage-saved" errorTestId="signage-save-error" />

      {config ? (
        <>
          <FormRow>
            <Field label="サイネージモード" htmlFor="signage-enabled">
              <label style={{ display: 'flex', gap: space.xs, alignItems: 'center' }}>
                <input
                  id="signage-enabled"
                  data-testid="signage-enabled"
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
                <span>有効にする</span>
              </label>
            </Field>
            <Field
              label="既定の表示間隔（秒）"
              htmlFor="signage-interval"
              error={errorFor('defaultIntervalSeconds')}
            >
              <input
                id="signage-interval"
                data-testid="signage-interval"
                type="number"
                min={3}
                max={600}
                value={config.defaultIntervalSeconds}
                onChange={(e) => update({ defaultIntervalSeconds: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>
          </FormRow>

          {errorFor('items') ? (
            <p data-testid="signage-items-error" style={{ color: color.danger }}>
              {errorFor('items')}
            </p>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, marginTop: space.md }}>
            {config.items.map((item, index) => (
              <SignageItemEditor
                key={item.id}
                item={item}
                index={index}
                onChange={(patch) => updateItem(item.id, patch)}
                onRemove={() => removeItem(item.id)}
                errorFor={errorFor}
              />
            ))}
          </div>

          <div style={{ marginTop: space.md }}>
            <Button data-testid="signage-add-item" onClick={addItem}>
              ＋ コンテンツを追加
            </Button>
          </div>
        </>
      ) : (
        <p>読み込み中…</p>
      )}
    </Section>
  );
}

function SignageItemEditor({
  item,
  index,
  onChange,
  onRemove,
  errorFor,
}: {
  item: SignageItem;
  index: number;
  onChange: (patch: Partial<SignageItem>) => void;
  onRemove: () => void;
  errorFor: (field: string) => string | undefined;
}) {
  const at = (f: string) => `items[${index}].${f}`;
  return (
    <div
      data-testid="signage-item"
      style={{
        border: `1px solid ${color.borderStrong}`,
        borderRadius: radius.md,
        padding: space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: space.sm,
      }}
    >
      <FormRow>
        <Field label="種別" htmlFor={`${item.id}-type`}>
          <select
            id={`${item.id}-type`}
            data-testid="signage-item-type"
            value={item.type}
            onChange={(e) => onChange({ type: e.target.value as SignageContentType })}
            style={inputStyle}
          >
            {SIGNAGE_CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="有効" htmlFor={`${item.id}-enabled`}>
          <input
            id={`${item.id}-enabled`}
            data-testid="signage-item-enabled"
            type="checkbox"
            checked={item.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
        </Field>
        <Field label="表示秒数（任意・空で既定）" htmlFor={`${item.id}-duration`} error={errorFor(at('durationSeconds'))}>
          <input
            id={`${item.id}-duration`}
            type="number"
            min={3}
            max={600}
            value={item.durationSeconds ?? ''}
            onChange={(e) =>
              onChange({ durationSeconds: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            style={inputStyle}
          />
        </Field>
      </FormRow>

      {item.type === 'message' ? (
        <>
          <Field label="見出し（任意）" htmlFor={`${item.id}-title`}>
            <input
              id={`${item.id}-title`}
              value={item.title ?? ''}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="本文" htmlFor={`${item.id}-message`} error={errorFor(at('message'))}>
            <textarea
              id={`${item.id}-message`}
              data-testid="signage-item-message"
              value={item.message ?? ''}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </Field>
        </>
      ) : null}

      {item.type === 'image' ? (
        <>
          <Field label="画像 URL（http/https）" htmlFor={`${item.id}-imageUrl`} error={errorFor(at('imageUrl'))}>
            <input
              id={`${item.id}-imageUrl`}
              data-testid="signage-item-image-url"
              value={item.imageUrl ?? ''}
              onChange={(e) => onChange({ imageUrl: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="代替テキスト（任意）" htmlFor={`${item.id}-imageAlt`}>
            <input
              id={`${item.id}-imageAlt`}
              value={item.imageAlt ?? ''}
              onChange={(e) => onChange({ imageAlt: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </>
      ) : null}

      {item.type === 'slides' ? (
        <Field
          label="スライド URL（1 行に 1 つ・http/https）"
          htmlFor={`${item.id}-slides`}
          error={errorFor(at('slideUrls'))}
        >
          <textarea
            id={`${item.id}-slides`}
            data-testid="signage-item-slides"
            value={(item.slideUrls ?? []).join('\n')}
            onChange={(e) =>
              onChange({
                slideUrls: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </Field>
      ) : null}

      <div>
        <Button variant="danger" data-testid="signage-item-remove" onClick={onRemove}>
          削除
        </Button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  width: '100%',
};
