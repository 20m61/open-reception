'use client';

/**
 * VRM 不可時の静止画 fallback（#36 / #196）。
 *
 * VrmAvatarViewer（three.js を内包する遅延チャンク）と AvatarGuide（VRM 未設定時に
 * チャンクを読み込まず直接 fallback を出す側）の両方から使う共有マークアップ。
 * data-testid="vrm-fallback" は E2E（fallback 経路）の公開契約なのでどちらの経路でも同一。
 */
export function AvatarFallbackImage({ src, className }: { src: string; className?: string }) {
  return (
    <div className={className} data-testid="vrm-fallback" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </div>
  );
}
