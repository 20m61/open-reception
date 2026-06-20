'use client';

/**
 * 担当者応答ビュー (issue #4 increment 2c-残)。
 *
 * 通知リンクの署名付きトークンで応答エンドポイントを呼び、subscriber トークンを取得して
 * 通話に参加する。応答した時点でサーバ側は connected に確定する（markConnected）。
 * fallback-first: ビデオに参加できなくても画面の案内で状況がわかる。
 *
 * NOTE(要ライブ検証): 実 SDK 接続（VonageCallClient）は実 Vonage 認証情報・実機が前提。
 */
import { useEffect, useRef, useState } from 'react';
import { VonageCallClient } from '@/adapters/call/vonage-client';
import type { CallTokenResponse } from '@/lib/call/call-controller';

type StaffCallState = 'connecting' | 'connected' | 'error';

export type StaffCallViewProps = {
  receptionId: string;
  token: string;
};

export function StaffCallView({ receptionId, token }: StaffCallViewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<StaffCallState>('connecting');

  useEffect(() => {
    let stopped = false;
    const client = new VonageCallClient({ getContainer: () => containerRef.current ?? undefined });

    (async () => {
      try {
        const res = await fetch(`/api/staff/calls/${receptionId}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          if (!stopped) setState('error');
          return;
        }
        const data = (await res.json()) as CallTokenResponse;
        if (stopped) return;
        await client.connect({
          applicationId: data.applicationId,
          sessionId: data.sessionId,
          token: data.token,
          onConnected: () => {
            if (!stopped) setState('connected');
          },
          onError: () => {
            if (!stopped) setState('error');
          },
        });
      } catch {
        if (!stopped) setState('error');
      }
    })();

    return () => {
      stopped = true;
      void client.disconnect();
    };
  }, [receptionId, token]);

  return (
    <div className="staff-call" data-testid="staff-call" data-call-state={state}>
      <div ref={containerRef} className="staff-call__video" aria-hidden={state !== 'connected'} />
      <p className="staff-call__status" role="status">
        {state === 'connecting' && '通話に接続しています…'}
        {state === 'connected' && '通話中です。'}
        {state === 'error' && '通話に接続できませんでした。リンクの有効期限切れ、または別の端末で応答済みの可能性があります。'}
      </p>
    </div>
  );
}
