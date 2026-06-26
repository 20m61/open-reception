import { beforeEach, describe, expect, it } from 'vitest';
import { __resetBranding, getBrandingSettings, updateBrandingSettings } from './branding-store';

beforeEach(async () => {
  await __resetBranding();
});

describe('branding-store (#88)', () => {
  it('既定は未設定（汎用テーマ）', async () => {
    const b = await getBrandingSettings();
    expect(b.accentColor).toBeUndefined();
    expect(b.logoUrl).toBeUndefined();
    expect(b.companyName).toBeUndefined();
  });

  it('妥当なアクセント色・社名を保存し、色は小文字化する', async () => {
    const b = await updateBrandingSettings({ accentColor: '#1A2B3C', companyName: '  AVITA  ' });
    expect(b.accentColor).toBe('#1a2b3c');
    expect(b.companyName).toBe('AVITA');
  });

  it('不正なアクセント色は無視して既存を温存する', async () => {
    await updateBrandingSettings({ accentColor: '#abcdef' });
    const b = await updateBrandingSettings({ accentColor: 'red' });
    expect(b.accentColor).toBe('#abcdef');
  });

  it('空文字でクリアできる', async () => {
    await updateBrandingSettings({ companyName: 'X' });
    const b = await updateBrandingSettings({ companyName: '' });
    expect(b.companyName).toBeUndefined();
  });

  it('data:image ロゴは受け付け、外部 https は拒否する（CSP self/data: のみ）', async () => {
    const ok = await updateBrandingSettings({ logoUrl: 'data:image/png;base64,AAAA' });
    expect(ok.logoUrl).toBe('data:image/png;base64,AAAA');
    const rejected = await updateBrandingSettings({ logoUrl: 'https://evil.example/logo.png' });
    // 既存（data URI）を温存し、外部 URL は採用しない。
    expect(rejected.logoUrl).toBe('data:image/png;base64,AAAA');
  });

  it('同一オリジン相対パスのロゴは許可する', async () => {
    const b = await updateBrandingSettings({ logoUrl: '/assets/logo.svg' });
    expect(b.logoUrl).toBe('/assets/logo.svg');
  });
});
