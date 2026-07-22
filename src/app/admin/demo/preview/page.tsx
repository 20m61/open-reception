'use client';

import { useEffect, useState } from 'react';
import { KioskFlow } from '@/components/kiosk/KioskFlow';
import { createDemoKioskFetch } from '@/domain/demo-studio/mock-adapter';
import { deriveKioskFlowProps } from '@/domain/demo-studio/kiosk-injection';
import { isDemoScenario, type DemoScenario } from '@/domain/demo-studio/scenario';
import { getDemoScenario } from '@/domain/demo-studio/scenarios';

/**
 * Demo Harness の iframe ターゲット (issue #363 Increment 1 / Inc2 でカスタム解決を追加)。
 *
 * この**別ブラウジングコンテキスト**で `window.fetch` を Mock Adapter に差し替えてから、本番
 * `KioskFlow` を**無改変で** import・描画する。Mock Adapter は `/api/kiosk/*` のみをシナリオ駆動で
 * 返し、それ以外（本番 API・Vonage・集計）は `DemoSandboxViolation` で遮断する（sandbox 境界）。
 *
 * シナリオ解決（Inc2）: 組込テンプレートは同期解決（Inc1 と同一・非退行）。組込に無い id は
 * カスタム保存済みとみなし、`/api/admin/demo/scenarios/:id`（**保存済み→組込** で解決）を
 * **fetch 差し替え前に**同一オリジンで取得する。取得後に isDemoScenario で構造を再検証してから
 * Mock を注入する（保存時検証に加えた二重防御）。差し替え後の fetch はすべて Mock 経由になるため、
 * カスタムシナリオの取得は必ず差し替えより前に完了させる。
 *
 * fetch 差し替えは KioskFlow のマウント副作用（`useEffect` 内の初期 fetch 群）より前に完了させる
 * 必要がある。そこで effect で差し替え → status を 'ready' に更新し、その再レンダーで初めて
 * KioskFlow を描画する（KioskFlow の子 effect はこのレンダーのコミット後に走るため、常に Mock が
 * 有効）。SSR との hydration 齟齬も避けられる（初期レンダーは null 同士で一致）。
 */
type Status = 'loading' | 'ready' | 'unknown';

async function resolveScenario(id: string): Promise<DemoScenario | undefined> {
  // 組込テンプレートは同期解決（Inc1 非退行）。
  const builtin = getDemoScenario(id);
  if (builtin) return builtin;
  // カスタム: fetch 差し替え前に同一オリジンの admin API で取得する（保存済み→組込 解決）。
  try {
    const res = await fetch(`/api/admin/demo/scenarios/${encodeURIComponent(id)}`);
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    return isDemoScenario(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

export default function DemoPreviewPage() {
  const [status, setStatus] = useState<Status>('loading');
  // 解決済みシナリオ (#363 第7wave)。KioskFlow への注入 props（operatingStatus /
  // sttAdapterFactory / qrScanner）を deriveKioskFlowProps で導出するために保持する。
  const [scenario, setScenario] = useState<DemoScenario | undefined>(undefined);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('scenario');
    let cancelled = false;
    void (async () => {
      const resolved = id ? await resolveScenario(id) : undefined;
      if (cancelled) return;
      // 外部システム（この iframe の window.fetch）を Mock へ差し替える。以後この iframe 内の全 fetch は
      // Mock 経由になり、本番エンドポイントへは到達しない。差し替え後にその結果を React へ通知する。
      if (resolved) window.fetch = createDemoKioskFetch(resolved);
      setScenario(resolved);
      setStatus(resolved ? 'ready' : 'unknown');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') return null;
  if (status === 'unknown' || !scenario) {
    return (
      <main className="screen" data-testid="demo-preview-unknown" style={{ padding: 24 }}>
        <div className="notice notice--warning">
          不明なデモシナリオです。スタジオからやり直してください。
        </div>
      </main>
    );
  }

  // 本番 Kiosk を無改変で再利用（プレビュー専用の類似 UI を作らない, issue #363 安全設計）。
  // 外部注入点（#363 第7wave）: シナリオの initialMode/simulatedResults から導出した
  // operatingStatus/sttAdapterFactory/qrScanner を props で渡し、営業時間外・STT失敗・QR結果を
  // 実際の専用 UI として再現する（未該当は undefined のまま＝従来どおり）。
  return <KioskFlow {...deriveKioskFlowProps(scenario)} />;
}
