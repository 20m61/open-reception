import type { NextConfig } from 'next';

/**
 * セキュリティヘッダ (issue #6)。
 * CSP は受付端末/管理画面の双方で動くよう実用的な強度に設定する。
 * Next.js の hydration/inline style のため script/style は 'unsafe-inline' を許可しつつ、
 * frame-ancestors none・object-src none・base-uri self でクリックジャッキング/注入を抑止する。
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 受付端末では将来マイク/カメラ（音声/VRM）を self で許可、位置情報は不許可。
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
