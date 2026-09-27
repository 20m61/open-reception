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
import { StaffResponseActions } from './StaffResponseActions';
import { hasEnabledResponses, useStaffResponseActions } from './use-staff-response-actions';
import {
  staffCallFailureMessage,
  staffFailureForStatus,
  type StaffFailure,
} from './staff-failure';

/**
 * 🔴 **error は必ず原因を伴う (#1123)。** 原因を別 state に分けて既定値で補うと、
 * **その既定が嘘側（「リンクの有効期限切れ」）に倒れる**。将来 `setState('error')` だけ
 * 書く経路が増えると #973 / #1021 の嘘が黙って復活するので、**表現不能**にしておく。
 */
type StaffCallState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'error'; failure: StaffFailure };

export type StaffCallViewProps = {
  receptionId: string;
  token: string;
};

export function StaffCallView({ receptionId, token }: StaffCallViewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<StaffCallState>({ kind: 'connecting' });
  // 🔴 **文言と画面が同じ事実を見る (#1137)。** 取得をここへ持ち上げ、
  //    失敗文言（「下の応答からの返答も試せます」）と応答ボタンの両方へ同じ値を配る。
  const responseActions = useStaffResponseActions(receptionId, token);

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
          // 🔴 状態コードを見る。非 ok を一括で「リンク切れ」にしない (#1123)。
          if (!stopped) setState({ kind: 'error', failure: staffFailureForStatus(res.status) });
          return;
        }
        const data = (await res.json()) as CallTokenResponse;
        if (stopped) return;
        await client.connect({
          applicationId: data.applicationId,
          sessionId: data.sessionId,
          token: data.token,
          onConnected: () => {
            if (!stopped) setState({ kind: 'connected' });
          },
          onError: () => {
            // 通話の確立に失敗した。サーバが要求を断ったのではないので、リンクのせいにしない。
            if (!stopped) setState({ kind: 'error', failure: 'unreachable' });
          },
        });
      } catch {
        // 応答が返らなかった。**成否は分かっていない**ので、リンクのせいにしない。
        if (!stopped) setState({ kind: 'error', failure: 'unreachable' });
      }
    })();

    return () => {
      stopped = true;
      void client.disconnect();
    };
  }, [receptionId, token]);

  return (
    <div className="staff-call" data-testid="staff-call" data-call-state={state.kind}>
      <div ref={containerRef} className="staff-call__video" aria-hidden={state.kind !== 'connected'} />
      <p className="staff-call__status" role="status" data-testid="staff-call-status">
        {state.kind === 'connecting' && '通話に接続しています…'}
        {state.kind === 'connected' && '通話中です。'}
        {state.kind === 'error' &&
          staffCallFailureMessage(state.failure, {
            responsesShown: hasEnabledResponses(responseActions),
          })}
      </p>
      {/* 通話に参加できなくても応答アクションは選べる（fallback-first）(issue #99)。 */}
      <StaffResponseActions receptionId={receptionId} token={token} actions={responseActions} />
    </div>
  );
}
