'use client';

import { useEffect, useState } from 'react';
import { KioskFlow } from '@/components/kiosk/KioskFlow';
import { createDemoKioskFetch } from '@/domain/demo-studio/mock-adapter';
import { getDemoScenario } from '@/domain/demo-studio/scenarios';

/**
 * Demo Harness の iframe ターゲット (issue #363 Increment 1)。
 *
 * この**別ブラウジングコンテキスト**で `window.fetch` を Mock Adapter に差し替えてから、本番
 * `KioskFlow` を**無改変で** import・描画する。Mock Adapter は `/api/kiosk/*` のみをシナリオ駆動で
 * 返し、それ以外（本番 API・Vonage・集計）は `DemoSandboxViolation` で遮断する（sandbox 境界）。
 *
 * fetch 差し替えは KioskFlow のマウント副作用（`useEffect` 内の初期 fetch 群）より前に完了させる
 * 必要がある。そこで effect で差し替え → status を 'ready' に更新し、その再レンダーで初めて
 * KioskFlow を描画する（KioskFlow の子 effect はこのレンダーのコミット後に走るため、常に Mock が
 * 有効）。SSR との hydration 齟齬も避けられる（初期レンダーは null 同士で一致）。
 */
type Status = 'loading' | 'ready' | 'unknown';

export default function DemoPreviewPage() {
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('scenario');
    const scenario = id ? getDemoScenario(id) : undefined;
    // 外部システム（この iframe の window.fetch）を Mock へ差し替える。以後この iframe 内の全 fetch は
    // Mock 経由になり、本番エンドポイントへは到達しない。差し替え後にその結果を React へ通知する。
    if (scenario) window.fetch = createDemoKioskFetch(scenario);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部システム更新後の状態同期（意図的）
    setStatus(scenario ? 'ready' : 'unknown');
  }, []);

  if (status === 'loading') return null;
  if (status === 'unknown') {
    return (
      <main className="screen" data-testid="demo-preview-unknown" style={{ padding: 24 }}>
        <div className="notice notice--warning">
          不明なデモシナリオです。スタジオからやり直してください。
        </div>
      </main>
    );
  }

  // 本番 Kiosk を無改変で再利用（プレビュー専用の類似 UI を作らない, issue #363 安全設計）。
  return <KioskFlow />;
}
