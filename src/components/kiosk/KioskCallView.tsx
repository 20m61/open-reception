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
import type { CallStage, CallStageStatus } from '@/domain/kiosk/call-stages';

/** 応答待ちの上限（ミリ秒）。 */
const CALL_TIMEOUT_MS = 30_000;

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
};

export function KioskCallView({
  receptionId,
  onConnected,
  onTimeout,
  onFallback,
  stages,
  locale = DEFAULT_LOCALE,
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
      timeoutMs: CALL_TIMEOUT_MS,
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
  }, [receptionId]);

  return (
    <div className="kiosk-call" data-testid="kiosk-call" data-call-state={uiState}>
      {/* publisher（受付端末カメラ）の描画先。SDK が利用できないときは空のまま。 */}
      <div ref={containerRef} className="kiosk-call__video" aria-hidden={uiState !== 'connected'} />
      <p className="kiosk-call__status" role="status">
        {uiState === 'connecting' && '担当者を呼び出しています。少々お待ちください。'}
        {uiState === 'connected' && '応答がありました。まもなくお越しになります。'}
        {uiState === 'timeout' && '応答がありませんでした。'}
        {uiState === 'fallback' && '通話を開始できませんでした。画面の案内に沿ってお進みください。'}
      </p>
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
