import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCheckinBaseUrl } from './base-url';

function req(headers: Record<string, string> = {}, url = 'https://api.example.com/x'): Request {
  return new Request(url, { headers });
}

describe('resolveCheckinBaseUrl (#97)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.RESERVATION_CHECKIN_BASE_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('RESERVATION_CHECKIN_BASE_URL を最優先する', () => {
    process.env.RESERVATION_CHECKIN_BASE_URL = 'https://kiosk.example.com/';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(resolveCheckinBaseUrl(req())).toBe('https://kiosk.example.com');
  });

  it('NEXT_PUBLIC_APP_URL をフォールバックに使う', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(resolveCheckinBaseUrl(req())).toBe('https://app.example.com');
  });

  it('env が無ければ Origin ヘッダから推定する', () => {
    expect(resolveCheckinBaseUrl(req({ origin: 'https://origin.example.com' }))).toBe(
      'https://origin.example.com',
    );
  });

  it('forwarded host/proto からオリジンを組み立てる', () => {
    const got = resolveCheckinBaseUrl(
      req({ 'x-forwarded-host': 'fwd.example.com', 'x-forwarded-proto': 'https' }),
    );
    expect(got).toBe('https://fwd.example.com');
  });

  it('最後の手段としてリクエスト URL のオリジンを使う', () => {
    expect(resolveCheckinBaseUrl(req({}, 'https://req.example.com/api/x'))).toBe(
      'https://req.example.com',
    );
  });

  it('不正な env 値は無視してフォールバックする', () => {
    process.env.RESERVATION_CHECKIN_BASE_URL = 'not a url';
    expect(resolveCheckinBaseUrl(req({ origin: 'https://origin.example.com' }))).toBe(
      'https://origin.example.com',
    );
  });
});
