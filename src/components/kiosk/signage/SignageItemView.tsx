'use client';

import { useEffect, useState } from 'react';
import type { SignageItem } from '@/domain/signage/types';
import { nextIndex } from '@/domain/signage/rotation';
import { SignageClock } from './SignageClock';

/**
 * サイネージ 1 項目の表示 (issue #101, increment 1)。
 *
 * type ごとに時計/案内文/画像/スライドを描画する。slides は内部で URL を巡回する
 * （巡回判定は純関数 nextIndex に委譲）。画像は object-fit: contain で歪ませない。
 * 表示するのは運用者が設定した静的コンテンツのみで、来訪者の PII は含めない。
 */
export function SignageItemView({ item }: { item: SignageItem }) {
  switch (item.type) {
    case 'clock':
      return <SignageClock />;
    case 'message':
      return (
        <div data-testid="signage-message" style={{ textAlign: 'center', maxWidth: '80%' }}>
          {item.title ? (
            <h2 style={{ fontSize: 'clamp(28px, 6vw, 80px)', margin: '0 0 0.4em' }}>{item.title}</h2>
          ) : null}
          <p style={{ fontSize: 'clamp(18px, 3.5vw, 44px)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {item.message}
          </p>
        </div>
      );
    case 'image':
      return item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="signage-image"
          src={item.imageUrl}
          alt={item.imageAlt ?? ''}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : null;
    case 'slides':
      return <SlideShow urls={item.slideUrls ?? []} alt={item.imageAlt} intervalMs={6000} />;
    default:
      return null;
  }
}

/** スライドショー: URL 配列を一定間隔で巡回する。 */
function SlideShow({ urls, alt, intervalMs }: { urls: string[]; alt?: string; intervalMs: number }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (urls.length <= 1) return;
    const id = setInterval(() => setIndex((i) => nextIndex(i, urls.length)), intervalMs);
    return () => clearInterval(id);
  }, [urls.length, intervalMs]);

  if (urls.length === 0) return null;
  const url = urls[Math.min(index, urls.length - 1)];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid="signage-slide"
      src={url}
      alt={alt ?? ''}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
    />
  );
}
