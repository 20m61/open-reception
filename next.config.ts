import type { NextConfig } from 'next';

/**
 * セキュリティヘッダ (issue #6)。
 *
 * Content-Security-Policy はここでは付与しない（issue #200）:
 * script-src の nonce 化により CSP は per-request となるため、`src/proxy.ts` が
 * 生成・付与する（内容は `src/lib/security/csp.ts`）。ここで静的 CSP を併設すると
 * 二重ヘッダとなり、ブラウザは両方の積（intersection）を強制するため
 * nonce 許可が打ち消されてしまう。
 * proxy の matcher 対象外（_next/static 等のサブリソース）は CSP なしで配信されるが、
 * CSP が防御対象とするのは document であり、サブリソース側には不要。
 */
const securityHeaders = [
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
    return [
      { source: '/:path*', headers: securityHeaders },
      // 受付体験スタジオのプレビューのみ同一オリジン iframe を許可 (#363)。
      // 同一 key は後勝ちで上書きされる。CSP 側の frame-ancestors は src/proxy.ts が
      // per-request に 'self' へ切り替える（他ルートは 'none' / DENY のまま）。
      {
        source: '/admin/demo/preview',
        headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      },
    ];
  },
};

export default nextConfig;
