'use client';

import { useEffect, useState } from 'react';

/**
 * サイネージの時計コンテンツ (issue #101, increment 1)。
 *
 * 端末ローカル時刻を 1 秒ごとに更新表示する。外部素材・PII を要しない安全な既定。
 * 描画は CSS のみで GPU/CPU 負荷を抑える（issue #101 UX 方針: iPad 低負荷）。
 */
export function SignageClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // SSR とクライアント初回でロケール時刻がずれるのを避けるため、マウント後にのみ描画する。
  if (!now) return <div data-testid="signage-clock" aria-hidden style={{ minHeight: '1em' }} />;

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <div data-testid="signage-clock" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 'clamp(48px, 12vw, 160px)', fontWeight: 800, lineHeight: 1.1 }}>
        {time}
      </div>
      <div style={{ fontSize: 'clamp(18px, 3vw, 40px)', opacity: 0.8, marginTop: 8 }}>{date}</div>
    </div>
  );
}
