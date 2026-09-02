'use client';

/**
 * 受付端末が担当者の応答アクションを短時間ポーリングで取得するフック (issue #99 increment 1)。
 *
 * GET /api/kiosk/receptions/:id/status を一定間隔で叩き、staffResponse を反映する。
 * 取得失敗・応答なし時もポーリングを止めない（受付フローは壊さない）。新しい応答かどうかは
 * respondedAt で判定する（shouldReplaceResponse）。
 */
import { useEffect, useRef, useState } from 'react';
import type { StaffResponseResult } from '@/domain/reception/staff-response';

/** 既定ポーリング間隔（ミリ秒）。短時間反映と負荷のバランス。 */
export const STAFF_RESPONSE_POLL_MS = 3000;

export type ReceptionVisitorStatus = {
  state: string;
  staffResponse?: StaffResponseResult;
};

/**
 * 新しい応答で既存表示を置き換えるべきか。respondedAt が新しい応答のみ採用する
 * （同じ応答の再取得や、時刻が巻き戻る応答は無視）。純関数（ユニットテスト対象）。
 */
export function shouldReplaceResponse(
  current: StaffResponseResult | null,
  incoming: StaffResponseResult | undefined,
): boolean {
  if (!incoming) return false;
  if (!current) return true;
  return incoming.respondedAt > current.respondedAt;
}

/** 1 回のポーリング結果。取得できなければ `ok: false`（本文は無い）。 */
export type ReceptionStatusPoll =
  | { ok: true; status: ReceptionVisitorStatus }
  | { ok: false };

/**
 * 受付端末用フック。receptionId が null の間はポーリングしない。
 * enabled=false（終端状態など）でも停止する。
 *
 * **`/status` を叩くのはこの 1 本だけ** (issue #652)。かつては担当者応答（#99）と
 * 実 PSTN の結果確定（#647）が同じ URL を別々に 3 秒間隔で叩いていた。実害は 3 つあり、
 * 効く順に: サーバが毎リクエストで `resolvePendingCall`（相関読み込み＋確定時の書き込み）を
 * 走らせるので**遅延確定が丸ごと 2 倍**／テストから「どちらの経路の失敗か」を指定できず
 * **意味を固定できない**／リクエスト数。
 *
 * 🔴 **本文は返さず `onPoll` で渡す。** 「最新の本文」を戻り値にすると、呼び出し中ずっと
 * 3 秒ごとに再描画が起きる（受付端末は VRM を実描画しているので持ち込まない）。逆に
 * 変化時だけ返すと、本文が `calling` のまま変わらない間に**経過時間で判断する側**
 * （`give_up`）が反応できない。よって毎ポーリングは副作用（コールバック）で伝え、
 * 戻り値は表示に要る `staffResponse` だけに絞る。
 */
export function useStaffResponse(
  receptionId: string | null,
  options?: {
    enabled?: boolean;
    intervalMs?: number;
    /**
     * 毎ポーリングの結果を受け取る。**ref 経由で呼ぶのでループを再起動させない。**
     * deps に入れると毎描画でループが再起動し、呼び出し側が持つ経過時間の起点が
     * 永久にリセットされる（`give_up` が働かなくなる）。
     */
    onPoll?: (result: ReceptionStatusPoll) => void;
  },
): StaffResponseResult | null {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs ?? STAFF_RESPONSE_POLL_MS;
  const [response, setResponse] = useState<StaffResponseResult | null>(null);
  // 最新値を effect 内から参照し、ポーリングの再起動を避ける。
  // ref の更新は描画中ではなく effect で行う（react-hooks ルール準拠）。
  const responseRef = useRef<StaffResponseResult | null>(null);
  const onPollRef = useRef<((result: ReceptionStatusPoll) => void) | undefined>(undefined);
  useEffect(() => {
    responseRef.current = response;
  });
  useEffect(() => {
    onPollRef.current = options?.onPoll;
  });

  useEffect(() => {
    if (!receptionId || !enabled) return;
    let cancelled = false;

    const poll = async () => {
      let result: ReceptionStatusPoll = { ok: false };
      try {
        const res = await fetch(`/api/kiosk/receptions/${receptionId}/status`, { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as ReceptionVisitorStatus;
          if (cancelled) return;
          result = { ok: true, status: data };
          if (shouldReplaceResponse(responseRef.current, data.staffResponse)) {
            setResponse(data.staffResponse ?? null);
          }
        }
      } catch {
        /* 取得失敗はポーリングを止めない（受付フローを壊さない）。ok:false として伝える */
      }
      if (cancelled) return;
      onPollRef.current?.(result);
    };

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [receptionId, enabled, intervalMs]);

  // receptionId が変わったら応答もリセットする（別受付に持ち越さない）。
  useEffect(() => {
    setResponse(null);
  }, [receptionId]);

  return response;
}
