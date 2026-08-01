import { beforeEach, describe, expect, it } from 'vitest';
import { __resetBranding, getBrandingSettings, updateBrandingSettings } from './branding-store';

const T = 'internal';

beforeEach(async () => {
  await __resetBranding();
});

describe('branding-store (#88)', () => {
  it('既定は未設定（汎用テーマ）', async () => {
    const b = await getBrandingSettings(T);
    expect(b.accentColor).toBeUndefined();
    expect(b.logoUrl).toBeUndefined();
    expect(b.companyName).toBeUndefined();
  });

  it('妥当なアクセント色・社名を保存し、色は小文字化する', async () => {
    const b = await updateBrandingSettings(T, { accentColor: '#1A2B3C', companyName: '  AVITA  ' });
    expect(b.accentColor).toBe('#1a2b3c');
    expect(b.companyName).toBe('AVITA');
  });

  it('不正なアクセント色は無視して既存を温存する', async () => {
    await updateBrandingSettings(T, { accentColor: '#abcdef' });
    const b = await updateBrandingSettings(T, { accentColor: 'red' });
    expect(b.accentColor).toBe('#abcdef');
  });

  it('空文字でクリアできる', async () => {
    await updateBrandingSettings(T, { companyName: 'X' });
    const b = await updateBrandingSettings(T, { companyName: '' });
    expect(b.companyName).toBeUndefined();
  });

  it('data:image ロゴは受け付け、外部 https は拒否する（CSP self/data: のみ）', async () => {
    const ok = await updateBrandingSettings(T, { logoUrl: 'data:image/png;base64,AAAA' });
    expect(ok.logoUrl).toBe('data:image/png;base64,AAAA');
    const rejected = await updateBrandingSettings(T, { logoUrl: 'https://evil.example/logo.png' });
    // 既存（data URI）を温存し、外部 URL は採用しない。
    expect(rejected.logoUrl).toBe('data:image/png;base64,AAAA');
  });

  it('同一オリジン相対パスのロゴは許可する', async () => {
    const b = await updateBrandingSettings(T, { logoUrl: '/assets/logo.svg' });
    expect(b.logoUrl).toBe('/assets/logo.svg');
  });
});

/**
 * **テナント別に分離されていること** (#419 残増分)。
 *
 * 以前は固定キーの単一ストアで、`section-loaders.ts` が越境を避けるため既定テナント
 * 以外を fail-closed で落としていた（＝2 つ目のテナントはブランディングを使えなかった）。
 */
describe('branding-store のテナント分離 (#419)', () => {
  it('別テナントの設定は混ざらない', async () => {
    await __resetBranding('acme');
    await updateBrandingSettings(T, { companyName: 'DEFAULT-CO' });
    await updateBrandingSettings('acme', { companyName: 'ACME-CO' });

    expect((await getBrandingSettings(T)).companyName).toBe('DEFAULT-CO');
    expect((await getBrandingSettings('acme')).companyName).toBe('ACME-CO');
  });

  it('未設定のテナントは既定（汎用テーマ）で、他テナントの値を引き継がない', async () => {
    await __resetBranding('globex');
    await updateBrandingSettings(T, { accentColor: '#123456' });

    expect((await getBrandingSettings('globex')).accentColor).toBeUndefined();
  });

  it('あるテナントのクリアが他テナントへ波及しない', async () => {
    await __resetBranding('acme');
    await updateBrandingSettings(T, { companyName: 'KEEP' });
    await updateBrandingSettings('acme', { companyName: 'GONE' });
    await updateBrandingSettings('acme', { companyName: '' });

    expect((await getBrandingSettings('acme')).companyName).toBeUndefined();
    expect((await getBrandingSettings(T)).companyName).toBe('KEEP');
  });
});
