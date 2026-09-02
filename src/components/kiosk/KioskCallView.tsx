'use client';

/**
 * 受付端末のビデオ通話ビュー (issue #4 increment 2c)。
 *
 * Vonage（非同期）通話のとき、calling 状態の受付端末に publisher を描画し、
 * call-controller でライフサイクルを駆動する:
 *   token 取得 → 接続 → 応答で onConnected、未応答で onTimeout、失敗で onFallback。
 * fallback-first: ビデオが使えなくても受付フロー（テキスト案内）を止めない。
 *
 * NOTE(要ライブ検証): 実 SDK 接続（VonageCallClient）は実 Vonage 認証情報・実機が前提。
 * 本コンポーネントの制御は call-controller / VonageCallClient（いずれも単体テスト済み）に委譲する。
 */
import { useEffect, useRef, useState } from 'react';
import { createCallController, type CallTokenResponse, type CallUiState } from '@/lib/call/call-controller';
import { VonageCallClient } from '@/adapters/call/vonage-client';
import { makeT, htmlLangFor, DEFAULT_LOCALE, type Locale, type MessageKey } from '@/lib/i18n';
import { DEFAULT_VIDEO_ANSWER_TIMEOUT_MS } from '@/domain/reception/calling-experience';
import type { CallStage, CallStageStatus } from '@/domain/kiosk/call-stages';

/** 応答待ちの上限は `DEFAULT_VIDEO_ANSWER_TIMEOUT_MS`。E2E は props / `?callTimeoutMs=` で短縮する。 */

/** 段階状態 → i18n ラベルキー（未知状態は増やさず 3 種で網羅）。 */
const STAGE_STATUS_KEY: Record<CallStageStatus, MessageKey> = {
  pending: 'kiosk.callStages.status.pending',
  active: 'kiosk.callStages.status.active',
  done: 'kiosk.callStages.status.done',
};

export type KioskCallViewProps = {
  receptionId: string;
  onConnected: () => void;
  onTimeout: () => void;
  onFallback: () => void;
  /**
   * 取次段階（#363 injection point 4）。`/call` 応答が `stages[]` を返したときのみ表示する。
   * 旧形（stages 無し）は空配列/undefined で、従来どおり何も足さない（後方互換）。
   */
  stages?: CallStage[];
  /** 段階見出し/状態ラベルの表示言語（#103）。既定は ja。 */
  locale?: Locale;
  /**
   * 担当者の応答待ち上限（#832）。未指定は 30s。来訪者向けの予告は CallingView が持つので、
   * ここを短くしても予告無しで結果へ飛ばない（親がゲートへ送る）。
   */
  timeoutMs?: number;
};

export function KioskCallView({
  receptionId,
  onConnected,
  onTimeout,
  onFallback,
  stages,
  locale = DEFAULT_LOCALE,
  timeoutMs = DEFAULT_VIDEO_ANSWER_TIMEOUT_MS,
}: KioskCallViewProps): React.ReactElement {
  const tr = makeT(locale);
  const containerRef = useRef<HTMLDivElement>(null);
  const [uiState, setUiState] = useState<CallUiState>('connecting');

  // コールバックは ref 経由で参照し、effect の再実行（再接続）を避ける。
  // ref の更新は描画中ではなく effect で行う（react-hooks ルール準拠）。
  const cbRef = useRef({ onConnected, onTimeout, onFallback });
  useEffect(() => {
    cbRef.current = { onConnected, onTimeout, onFallback };
  });

  useEffect(() => {
    const client = new VonageCallClient({ getContainer: () => containerRef.current ?? undefined });
    const controller = createCallController({
      fetchToken: async () => {
        const res = await fetch(`/api/kiosk/receptions/${receptionId}/token`);
        return res.ok ? ((await res.json()) as CallTokenResponse) : null;
      },
      reportConnected: async () => {
        await fetch(`/api/kiosk/receptions/${receptionId}/connected`, { method: 'POST' });
      },
      reportTimeout: async () => {
        await fetch(`/api/kiosk/receptions/${receptionId}/timeout`, { method: 'POST' });
      },
      client,
      timeoutMs,
      onState: (state) => {
        setUiState(state);
        if (state === 'connected') cbRef.current.onConnected();
        else if (state === 'timeout') cbRef.current.onTimeout();
        else if (state === 'fallback') cbRef.current.onFallback();
      },
    });
    void controller.start();
    return () => {
      void controller.stop();
    };
  }, [receptionId, timeoutMs]);

  return (
    <div className="kiosk-call" data-testid="kiosk-call" data-call-state={uiState}>
      {/* publisher（受付端末カメラ）の描画先。SDK が利用できないときは空のまま。 */}
      <div ref={containerRef} className="kiosk-call__video" aria-hidden={uiState !== 'connected'} />
      {/*
        待ち中の文言は CallingView（`data-calling-stage`）が担う (#832 / #849)。
        ここに connecting/timeout を出すと role="status" が二重になり、予告がビデオ側の
        「接続中」に隠れる。fallback だけ残す（親が CALL_FAILED するまでの短い窓）。
      */}
      {uiState === 'fallback' ? (
        <p className="kiosk-call__status" role="status" lang={htmlLangFor(locale)}>
          {tr('kiosk.call.fallback')}
        </p>
      ) : null}
      {stages && stages.length > 0 ? (
        <div className="kiosk-call__stages" data-testid="kiosk-call-stages" lang={htmlLangFor(locale)}>
          <p className="card__sub">{tr('kiosk.callStages.label')}</p>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {stages.map((stage) => (
              <li
                key={stage.key}
                data-testid={`kiosk-call-stage-${stage.key}`}
                data-stage-status={stage.status}
              >
                <span>{stage.key}</span>
                <span className="card__sub"> — {tr(STAGE_STATUS_KEY[stage.status])}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
