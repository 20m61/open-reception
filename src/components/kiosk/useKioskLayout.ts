'use client';

import { useEffect, useState } from 'react';
import { resolveKioskLayout, type KioskLayout } from './layout';

/**
 * 現在の viewport から受付端末のレイアウトプロファイルを返すフック (issue #124)。
 *
 * 配置・サイズの真実源は純ロジック `resolveKioskLayout`。本フックは viewport 測定と
 * リサイズ/回転への追従だけを担う。SSR（window 不在）では安全側の 'ipad-portrait' を返し、
 * マウント後に実測へ更新する（ハイドレーション後に正しい配置へ収束する）。
 */
export function useKioskLayout(): KioskLayout {
  const [layout, setLayout] = useState<KioskLayout>('ipad-portrait');

  useEffect(() => {
    const measure = () =>
      setLayout(resolveKioskLayout({ width: window.innerWidth, height: window.innerHeight }));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  return layout;
}
