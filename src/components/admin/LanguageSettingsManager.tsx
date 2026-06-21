'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  LOCALE_NATIVE_LABEL,
  SUPPORTED_LOCALES,
  type Locale,
} from '@/lib/i18n';
import type { LanguageSettings } from '@/lib/i18n/language-settings';
import { Button, Field } from '@/components/admin/ui';

/**
 * 言語設定 (issue #103, increment 1)。受付で出す言語（有効言語）と初期表示言語を選ぶ。
 * 不変条件はサーバ側 sanitizeLanguageSettings で最終補正される（既定言語は有効言語内に補正）。
 */
export function LanguageSettingsManager() {
  const [s, setS] = useState<LanguageSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/languages');
    if (res.ok) setS((await res.json()) as LanguageSettings);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (locale: Locale) =>
    setS((cur) => {
      if (!cur) return cur;
      const has = cur.enabledLocales.includes(locale);
      const enabledLocales = has
        ? cur.enabledLocales.filter((l) => l !== locale)
        : SUPPORTED_LOCALES.filter((l) => cur.enabledLocales.includes(l) || l === locale);
      return { ...cur, enabledLocales };
    });

  const save = useCallback(async () => {
    if (!s || busy) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/languages', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(s),
      });
      if (res.ok) {
        setS((await res.json()) as LanguageSettings);
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  }, [s, busy]);

  if (!s) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>言語設定</h1>
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>言語設定</h1>
      <p style={{ color: 'var(--color-muted, #666)' }}>
        受付端末で選べる言語と、最初に表示する言語を設定します。音声が使えない場合も画面で受付を完了できます。
      </p>

      <fieldset style={fieldset}>
        <legend style={legend}>受付で出す言語</legend>
        {SUPPORTED_LOCALES.map((locale) => (
          <label key={locale} style={chk}>
            <input
              type="checkbox"
              data-testid={`lang-enabled-${locale}`}
              checked={s.enabledLocales.includes(locale)}
              onChange={() => toggle(locale)}
            />
            <span lang={locale}>{LOCALE_NATIVE_LABEL[locale]}</span>
          </label>
        ))}
      </fieldset>

      <Field label="初期表示する言語" htmlFor="lang-default">
        <select
          id="lang-default"
          data-testid="lang-default"
          value={s.defaultLocale}
          onChange={(e) => setS((cur) => (cur ? { ...cur, defaultLocale: e.target.value as Locale } : cur))}
          style={input}
        >
          {s.enabledLocales.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NATIVE_LABEL[locale]}
            </option>
          ))}
        </select>
      </Field>

      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button variant="primary" data-testid="lang-save" onClick={save} disabled={busy} style={saveBtn}>
          {busy ? '保存中…' : '保存'}
        </Button>
        {saved ? <span style={{ color: 'var(--color-success, #16a34a)' }}>保存しました</span> : null}
      </div>
    </section>
  );
}

const fieldset: React.CSSProperties = { border: '1px solid var(--color-border, #ddd)', borderRadius: 12, padding: 16, marginBottom: 24 };
const legend: React.CSSProperties = { padding: '0 8px', fontWeight: 600 };
const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' };
const input: React.CSSProperties = { padding: '10px 12px', fontSize: 16, borderRadius: 8, border: '1px solid var(--color-border, #ccc)' };
const saveBtn: React.CSSProperties = { minHeight: 44, padding: '10px 24px', fontSize: 16 };
