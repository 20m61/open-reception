'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_SCENARIOS } from '@/domain/demo-studio/scenarios';
import type { DemoInitialMode } from '@/domain/demo-studio/scenario';

/**
 * 受付体験スタジオ Demo Harness (issue #363 Increment 1)。
 *
 * 本番 Kiosk コンポーネントを **iframe（`/admin/demo/preview`）内で無改変のまま**動かす。
 * その iframe の `window.fetch` を Mock Adapter に差し替えることで、本番 API・Vonage 発信・
 * 本番集計へ一切到達させない（sandbox boundary）。ここ（親ページ）は本番受付とは別画面・別権限で、
 * シナリオ選択と「デモ開始」（＝監査記録 + iframe 起動）だけを担う。
 */

const MODE_LABEL: Record<DemoInitialMode, string> = {
  signage: 'サイネージ',
  attract: 'ATTRACT',
  reception: '受付',
  qr: 'QR受付',
  out_of_hours: '営業時間外',
};

type RunState = 'idle' | 'running' | 'error';

/** プレビューの内部解像度（横向き iPad 相当。#361 の 35%/65% レール検証と同値）。 */
const PREVIEW_WIDTH = 1080;
const PREVIEW_HEIGHT = 810;

export function DemoStudio() {
  const [selectedId, setSelectedId] = useState<string>(DEMO_SCENARIOS[0]?.id ?? '');
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>('idle');
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // プレビューは横向き iPad 実寸(1080x810)で描画し、コンテナ幅に合わせて縮小表示する。
  // CSS サイズ=iframe viewport のため、小さい枠にそのまま流し込むと本番と異なる
  // 縮こまったレイアウトになる(実ブラウザ検証 2026-07-22 で発覚)。
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const measure = () => setPreviewScale(Math.min(1, el.clientWidth / PREVIEW_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewSrc]);

  const selected = useMemo(
    () => DEMO_SCENARIOS.find((s) => s.id === selectedId),
    [selectedId],
  );

  const run = useCallback(async () => {
    if (!selected) return;
    setRunState('running');
    try {
      // デモ実行の事実を監査に残す (issue #363 AC)。失敗しても preview 自体は sandbox 内で
      // 完結するため表示は続けるが、記録できないことは明示する。
      const res = await fetch('/api/admin/demo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: selected.id }),
      });
      if (!res.ok) {
        setRunState('error');
      } else {
        setRunState('idle');
      }
    } catch {
      setRunState('error');
    }
    // 監査記録の成否に関わらず、sandbox プレビューは起動する（Mock 注入・本番非接続）。
    // クエリにタイムスタンプを付けて再実行時に必ずリロードさせる。
    setPreviewSrc(`/admin/demo/preview?scenario=${encodeURIComponent(selected.id)}&t=${Date.now()}`);
  }, [selected]);

  return (
    <div className="stack" data-testid="demo-studio" style={{ gap: 'var(--space-lg)' }}>
      <header className="stack" style={{ gap: 'var(--space-xs)' }}>
        <h1 className="page__title">受付体験スタジオ（デモ）</h1>
        <p className="page__lead">
          本番の受付端末画面を、模擬データ（Mock）で安全に試せます。ここでの操作は本番の呼び出し・
          利用量・コスト集計には一切含まれません。
        </p>
        <p
          className="notice notice--info"
          data-testid="demo-sandbox-note"
          style={{ margin: 0 }}
        >
          サンドボックス: このデモは本番 API・電話発信・集計へ接続しません（プレビューは分離された
          枠内で動作します）。
        </p>
      </header>

      <div
        className="stack"
        style={{ gap: 'var(--space-md)', flexDirection: 'row', alignItems: 'flex-start', display: 'flex' }}
      >
        {/* シナリオ選択 */}
        <section
          className="card stack"
          data-testid="demo-scenario-list"
          style={{ gap: 'var(--space-xs)', minWidth: 260, flex: '0 0 auto' }}
        >
          <h2 className="card__title">シナリオ</h2>
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 4 }}>
            {DEMO_SCENARIOS.map((s) => {
              const isSelected = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid={`demo-scenario-${s.id}`}
                    data-selected={isSelected ? 'true' : undefined}
                    aria-pressed={isSelected}
                    className={`btn ${isSelected ? 'btn--primary' : 'btn--ghost'}`}
                    style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span>{s.name}</span>
                    <span className="badge" style={{ marginLeft: 'auto' }}>
                      {MODE_LABEL[s.initialMode]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            data-testid="demo-run"
            className="btn btn--primary"
            disabled={!selected || runState === 'running'}
            onClick={() => void run()}
          >
            {runState === 'running' ? '開始中…' : 'このシナリオでデモ開始'}
          </button>
          {runState === 'error' ? (
            <p className="notice notice--warning" data-testid="demo-run-error" style={{ margin: 0 }}>
              デモ実行の監査記録に失敗しました（プレビューは表示されます）。
            </p>
          ) : null}
        </section>

        {/* 横向き iPad プレビュー（本番 Kiosk を iframe で無改変再生） */}
        <section className="card stack" style={{ gap: 'var(--space-sm)', flex: '1 1 auto' }}>
          <h2 className="card__title">ライブプレビュー（横向きiPad）</h2>
          {previewSrc ? (
            <div
              ref={previewBoxRef}
              style={{
                position: 'relative',
                width: '100%',
                maxWidth: PREVIEW_WIDTH,
                aspectRatio: `${PREVIEW_WIDTH} / ${PREVIEW_HEIGHT}`,
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <iframe
                ref={frameRef}
                data-testid="demo-preview-frame"
                title="受付端末デモプレビュー"
                src={previewSrc}
                // 別ブラウジングコンテキスト（分離した window.fetch）が sandbox 境界の本体。
                // allow-same-origin は同一オリジンのプレビューページの動作に必要。
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: PREVIEW_WIDTH,
                  height: PREVIEW_HEIGHT,
                  border: 0,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          ) : (
            <p className="page__lead" data-testid="demo-preview-empty">
              シナリオを選んで「デモ開始」を押すと、本番の受付画面が模擬データで表示されます。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
