import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCheckoutUrl, checkoutQrDataUrl, safeCheckoutQrDataUrl } from './credential-display';
import { extractCheckoutToken } from './self-id';

const TOKEN = 'abc123_-DEF456';

describe('buildCheckoutUrl (issue #342)', () => {
  it('退館 checkout URL に token を ct クエリで載せる', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com', TOKEN);
    expect(url).toBe(`https://kiosk.example.com/kiosk/checkout?ct=${TOKEN}`);
  });

  it('末尾スラッシュを正規化する', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com/', TOKEN);
    expect(url).toBe(`https://kiosk.example.com/kiosk/checkout?ct=${TOKEN}`);
  });

  it('組み立てた URL は退館側の extractCheckoutToken で往復する（同じ token に解決）', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com', TOKEN);
    expect(extractCheckoutToken(url)).toBe(TOKEN);
  });
});

describe('checkoutQrDataUrl (issue #342)', () => {
  it('SVG の data URL を返す', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com', TOKEN);
    const dataUrl = checkoutQrDataUrl(url, '退館用QRコード');
    expect(dataUrl.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(dataUrl.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('<svg');
    expect(svg).toContain('<rect');
    expect(svg).toContain('aria-label="退館用QRコード"');
  });

  it('token は QR 画素へ符号化され、SVG マークアップに平文で現れない（漏洩防止）', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com', TOKEN);
    const dataUrl = checkoutQrDataUrl(url, 'qr');
    const svg = decodeURIComponent(dataUrl.slice('data:image/svg+xml,'.length));
    expect(svg).not.toContain(TOKEN);
    expect(svg).not.toContain('kiosk.example.com');
  });
});

describe('safeCheckoutQrDataUrl (issue #342 robustness)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('正常系は checkoutQrDataUrl と同じ data URL を返す', () => {
    const url = buildCheckoutUrl('https://kiosk.example.com', TOKEN);
    expect(safeCheckoutQrDataUrl(url, 'qr')).toBe(checkoutQrDataUrl(url, 'qr'));
  });

  it('QR 符号化が例外を投げても throw せず null を返す（完了画面をクラッシュさせない）', () => {
    // QR 容量を超える長大な文字列は encodeToMatrix（qrcode-generator）が throw する。
    const tooLong = 'x'.repeat(8000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 生成関数は throw する（= 完了画面を巻き添えにし得る）ことをまず確認する。
    expect(() => checkoutQrDataUrl(tooLong, 'qr')).toThrow();
    // 安全版は throw せず null（QR 省略で code/案内は残せる）。
    expect(safeCheckoutQrDataUrl(tooLong, 'qr')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
