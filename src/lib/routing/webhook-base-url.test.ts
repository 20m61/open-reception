/**
 * 発信コールバック用の基底オリジン (#646 / #612)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDialCallbackBaseUrl, resolveWebhookBaseUrl } from './webhook-base-url';

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://abc123.lambda-url.ap-northeast-1.on.aws/api/x', { headers });
}

describe('resolveDialCallbackBaseUrl (#646)', () => {
  it('明示設定を最優先する', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://reception.example';
    expect(resolveDialCallbackBaseUrl(request())).toBe('https://reception.example');
  });

  it('x-forwarded-host（CloudFront が付ける実ホスト）を使う', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      resolveDialCallbackBaseUrl(request({ 'x-forwarded-host': 'reception.example' })),
    ).toBe('https://reception.example');
  });

  /**
   * 🔴 **ここが本体。** `resolveWebhookBaseUrl` は最後の手段として `request.url` を返すので、
   * 「分からない」を表現できず「撃たない」判断ができない。Function URL を Vonage へ渡すと
   * 当該通話の webhook が全部 403 になり、鳴らしたのに一切進まない通話が残る。
   */
  it('🔴 どちらも無ければ undefined ── request.url（Function URL）へ倒れない', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveDialCallbackBaseUrl(request())).toBeUndefined();
    // 比較対象: 表示用は非空を返し続ける（既存の契約を変えていない）。
    expect(resolveWebhookBaseUrl(request())).toContain('lambda-url');
  });
});
