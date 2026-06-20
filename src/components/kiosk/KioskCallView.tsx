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

/** 応答待ちの上限（ミリ秒）。 */
const CALL_TIMEOUT_MS = 30_000;

export type KioskCallViewProps = {
  receptionId: string;
  onConnected: () => void;
  onTimeout: () => void;
  onFallback: () => void;
};

export function KioskCallView({ receptionId, onConnected, onTimeout, onFallback }: KioskCallViewProps): React.ReactElement {
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
    </div>
  );
}
