'use client';

import { useMemo, useState } from 'react';
import type { FlowField } from '@/domain/reception/custom-flow';
import { DEFAULT_LOCALE, htmlLangFor, makeT, type Locale } from '@/lib/i18n';
import {
  areRequiredFieldsSatisfied,
  initialFieldValues,
  unsatisfiedRequiredKeys,
} from './field-values';
import type { FlowFieldValues } from './types';

/**
 * 来訪者情報入力フォーム（受付端末・カスタムフロー） (issue #100, increment 1)。
 *
 * フロー定義の fields から動的にフォームを描画する。MVP の 4 タイプ（text/textarea/
 * select/checkbox）に対応する。必須が満たされるまで送信を無効化する。スタンドアロン:
 * 送信値は onSubmit で呼び出し元へ渡す（KioskFlow への組み込みは後段で配線）。戻る操作は
 * onBack で目的選択へ戻せる（目的選択を間違えた場合に戻れる／通常受付へ戻せる UX 方針）。
 *
 * 画面の固定文言は i18n カタログ経由 (#327)。項目ラベル・選択肢はテナントが管理画面で
 * 入力した値なので翻訳しない（入力された言語のまま出す）。
 */
export function VisitorInfoForm({
  fields,
  onSubmit,
  onBack,
  locale = DEFAULT_LOCALE,
}: {
  fields: readonly FlowField[];
  onSubmit: (values: FlowFieldValues) => void;
  onBack?: () => void;
  locale?: Locale;
}) {
  const tr = makeT(locale);
  const [values, setValues] = useState<FlowFieldValues>(() => initialFieldValues(fields));

  const invalidKeys = useMemo(() => new Set(unsatisfiedRequiredKeys(fields, values)), [fields, values]);
  const canSubmit = areRequiredFieldsSatisfied(fields, values);

  const setValue = (key: string, value: string | boolean) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      data-testid="visitor-info-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(values);
      }}
      lang={htmlLangFor(locale)}
      style={{ display: 'grid', gap: 16 }}
    >
      <h2 style={{ margin: 0 }}>{tr('reception.visitorInfoPrompt')}</h2>
      {fields.map((field) => (
        <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: '1rem' }}>
            {field.label}
            {field.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
          </span>
          <FieldControl
            field={field}
            value={values[field.key]}
            invalid={invalidKeys.has(field.key)}
            selectPlaceholder={tr('customFlow.selectPlaceholder')}
            onChange={(v) => setValue(field.key, v)}
          />
        </label>
      ))}

      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {onBack ? (
          <button type="button" data-testid="visitor-back" onClick={onBack} className="btn btn--secondary">
            {tr('reception.back')}
          </button>
        ) : null}
        <button type="submit" data-testid="visitor-submit" disabled={!canSubmit} className="btn btn--primary">
          {tr('reception.proceedConfirm')}
        </button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  value,
  invalid,
  selectPlaceholder,
  onChange,
}: {
  field: FlowField;
  value: string | boolean | undefined;
  invalid: boolean;
  /** select の未選択時プレースホルダ（訳文は呼び出し側が解決する）。 */
  selectPlaceholder: string;
  onChange: (value: string | boolean) => void;
}) {
  const border = invalid ? '1px solid var(--color-danger)' : '1px solid var(--color-surface-2)';
  const textValue = typeof value === 'string' ? value : '';

  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          data-testid="field-input"
          data-field-key={field.key}
          value={textValue}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          style={{ ...controlStyle, border, minHeight: 88 }}
        />
      );
    case 'select':
      return (
        <select
          data-testid="field-input"
          data-field-key={field.key}
          value={textValue}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...controlStyle, border }}
        >
          <option value="">{selectPlaceholder}</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'checkbox':
      return (
        <input
          type="checkbox"
          data-testid="field-input"
          data-field-key={field.key}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 28, height: 28 }}
        />
      );
    case 'text':
    default:
      return (
        <input
          type="text"
          data-testid="field-input"
          data-field-key={field.key}
          value={textValue}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...controlStyle, border }}
        />
      );
  }
}

const controlStyle: React.CSSProperties = {
  minHeight: 48,
  padding: '10px 14px',
  borderRadius: 10,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontSize: '1rem',
};
