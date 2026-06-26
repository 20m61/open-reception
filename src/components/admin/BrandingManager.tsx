'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_LOGO_DATA_URI_LENGTH, type BrandingSettings } from '@/domain/branding/types';
import { Button, Field } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

/**
 * ブランディング設定 (issue #88)。会社ロゴ・アクセント色・社名を待機画面に反映する。
 * ロゴは data URI として保存（CSP self/data: に適合）。
 */
export function BrandingManager() {
  const [b, setB] = useState<BrandingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/branding');
    if (res.ok) setB((await res.json()) as BrandingSettings);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<BrandingSettings>) => setB((cur) => (cur ? { ...cur, ...p } : cur));

  const onPickLogo = useCallback((file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('画像ファイルを選択してください。');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result);
      if (dataUri.length > MAX_LOGO_DATA_URI_LENGTH) {
        setError('ロゴが大きすぎます（約 512KB 以下にしてください）。');
        return;
      }
      patch({ logoUrl: dataUri });
    };
    reader.readAsDataURL(file);
  }, []);

  const save = useCallback(async () => {
    if (!b || busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch('/api/admin/branding', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
      if (res.ok) {
        setB((await res.json()) as BrandingSettings);
        setSaved(true);
      } else {
        setError('保存に失敗しました。');
      }
    } finally {
      setBusy(false);
    }
  }, [b, busy]);

  if (!b)
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>ブランド</h1>
        <p>読み込み中…</p>
      </section>
    );

  const accent = b.accentColor ?? '#38bdf8';

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>ブランド</h1>
      <p style={{ color: color.muted, marginTop: 0 }}>
        会社ロゴ・アクセント色・社名を受付の待機画面に反映します（「会社の顔」）。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <Field label="会社名（待機画面に表示・任意）" htmlFor="brand-company-input">
          <input
            id="brand-company-input"
            data-testid="brand-company"
            value={b.companyName ?? ''}
            maxLength={60}
            onChange={(e) => patch({ companyName: e.target.value })}
            style={input}
          />
        </Field>

        <Field label="アクセント色" htmlFor="brand-accent-input">
          <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
            <input
              id="brand-accent-input"
              type="color"
              data-testid="brand-accent"
              value={accent}
              onChange={(e) => patch({ accentColor: e.target.value })}
              style={{ width: 56, height: 40, padding: 2, borderRadius: 8, border: '1px solid var(--color-surface-2)', background: 'transparent' }}
            />
            <input
              aria-label="アクセント色（16進）"
              data-testid="brand-accent-hex"
              value={accent}
              onChange={(e) => patch({ accentColor: e.target.value })}
              style={{ ...input, width: 140 }}
            />
            <button type="button" data-testid="brand-accent-clear" onClick={() => patch({ accentColor: undefined })} style={linkBtn}>
              既定に戻す
            </button>
          </div>
        </Field>

        <Field label="ロゴ画像（PNG/SVG 等・約 512KB 以下）" htmlFor="brand-logo-file">
          <div style={{ display: 'flex', gap: space.md, alignItems: 'center', flexWrap: 'wrap' }}>
            {b.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={b.logoUrl}
                alt="ロゴプレビュー"
                data-testid="brand-logo-preview"
                style={{ height: 56, maxWidth: 200, objectFit: 'contain', background: 'var(--color-surface)', borderRadius: 8, padding: 4 }}
              />
            ) : (
              <span style={{ color: color.muted }}>未設定</span>
            )}
            <input
              id="brand-logo-file"
              ref={fileRef}
              type="file"
              accept="image/*"
              data-testid="brand-logo-file"
              onChange={(e) => onPickLogo(e.target.files?.[0])}
            />
            {b.logoUrl ? (
              <button
                type="button"
                data-testid="brand-logo-clear"
                onClick={() => {
                  patch({ logoUrl: undefined });
                  if (fileRef.current) fileRef.current.value = '';
                }}
                style={linkBtn}
              >
                ロゴを削除
              </button>
            ) : null}
          </div>
        </Field>

        {error ? (
          <p data-testid="brand-error" style={{ color: color.danger, margin: 0 }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" data-testid="brand-save" onClick={save} disabled={busy}>
            保存
          </Button>
          {saved ? (
            <span data-testid="brand-saved" style={{ color: color.success }}>
              保存しました
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-accent)',
  cursor: 'pointer',
  padding: 0,
  fontSize: '0.9rem',
};
