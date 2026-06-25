import type { NextConfig } from 'next';

/**
 * セキュリティヘッダ (issue #6)。
 * CSP は受付端末/管理画面の双方で動くよう実用的な強度に設定する。
 * Next.js の hydration/inline style のため script/style は 'unsafe-inline' を許可しつつ、
 * frame-ancestors none・object-src none・base-uri self でクリックジャッキング/注入を抑止する。
 */
// アセット（背景/アバター/フォント）は同一オリジン（CloudFront/S3 経由 or data:）で配信するため、
// img-src/media-src のスキームワイルドカード `https:`（ZAP 10055）は付けず self/data: に限定する。
// 外部 CDN を使う将来機能（#4 Vonage SDK）は、その時に必要 origin を明示追加する。
// VRM アバター (#31): three.js GLTFLoader は埋め込みテクスチャを blob: URL で読み込むため、
// img-src/connect-src に blob: を限定追加する（同一オリジン由来のオブジェクト URL のみ）。
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "media-src 'self' data:",
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
  // クロスオリジン分離（ZAP 90004 / 堅牢化）。リソースは同一オリジンのため require-corp で問題ない。
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
