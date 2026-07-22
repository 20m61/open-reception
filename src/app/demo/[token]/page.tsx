'use client';

import { use, useEffect, useState } from 'react';
import { KioskFlow } from '@/components/kiosk/KioskFlow';
import { createDemoKioskFetch, DEMO_CALL_FAILED_LATENCY_MS } from '@/domain/demo-studio/mock-adapter';
import { deriveKioskFlowProps } from '@/domain/demo-studio/kiosk-injection';
import { isDemoScenario, type DemoScenario } from '@/domain/demo-studio/scenario';

/**
 * 公開デモプレビュー（**認証なし**共有リンクの着地点）(issue #363 Increment 3・公開モデル)。
 *
 * URL: `/demo/<share-token>`。admin 領域（`/admin/demo/*`）とは別 route で、admin API を一切呼ばない。
 * 解決は公開エンドポイント `/api/demo/public/<token>`（published＋有効トークンのみ・シナリオのみ返す）で
 * 行い、以後は admin プレビュー（`/admin/demo/preview`）と**同一の sandbox**で本番 Kiosk を描画する:
 *   - この browsing context の `window.fetch` を Mock Adapter へ差し替える（`/api/kiosk/*` のみモック、
 *     それ以外は `DemoSandboxViolation` で既定拒否）。本番 API・Vonage・集計へは到達しない。
 *   - 本番 `KioskFlow` を無改変で再利用（プレビュー専用の類似 UI を作らない, #363 安全設計）。
 *
 * 二重防御: 公開 API が返したシナリオを `isDemoScenario` で再検証してから Mock を注入する。
 * fetch 差し替えは KioskFlow のマウント副作用より前に完了させる（status→'ready' 後に初描画）。
 */
type Status = 'loading' | 'ready' | 'unknown';

async function resolvePublicScenario(token: string): Promise<DemoScenario | undefined> {
  // fetch 差し替え**前**に公開 API を同一オリジンで取得する（差し替え後は Mock 経由になるため）。
  try {
    const res = await fetch(`/api/demo/public/${encodeURIComponent(token)}`);
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    const scenario = (data as { scenario?: unknown } | null)?.scenario;
    return isDemoScenario(scenario) ? scenario : undefined;
  } catch {
    return undefined;
  }
}

export default function PublicDemoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [status, setStatus] = useState<Status>('loading');
  const [scenario, setScenario] = useState<DemoScenario | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let originalFetch: typeof window.fetch | undefined;
    void (async () => {
      const resolved = await resolvePublicScenario(token);
      if (cancelled) return;
      // 外部システム（この context の window.fetch）を Mock へ差し替える。以後 admin API・本番 API へは
      // 到達しない（sandbox 境界）。call-failed の段階表示のため demo 側だけ /token に人工レイテンシ。
      if (resolved) {
        originalFetch = window.fetch;
        window.fetch = createDemoKioskFetch(resolved, { callLatencyMs: DEMO_CALL_FAILED_LATENCY_MS });
      }
      setScenario(resolved);
      setStatus(resolved ? 'ready' : 'unknown');
    })();
    return () => {
      cancelled = true;
      // 差し替えたままだと SPA 遷移後の同一オリジン fetch が sandbox で throw するため復元する。
      if (originalFetch) window.fetch = originalFetch;
    };
  }, [token]);

  if (status === 'loading') return null;
  if (status === 'unknown' || !scenario) {
    return (
      <main className="screen" data-testid="public-demo-unknown" style={{ padding: 24 }}>
        <div className="notice notice--warning">
          この公開デモリンクは無効か、有効期限が切れています。
        </div>
      </main>
    );
  }

  // 本番 Kiosk を無改変で再利用（公開経路でも同一 sandbox・同一コンポーネント）。
  return <KioskFlow {...deriveKioskFlowProps(scenario)} />;
}
