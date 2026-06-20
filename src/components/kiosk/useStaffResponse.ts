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

/**
 * 受付端末用フック。receptionId が null の間はポーリングしない。
 * enabled=false（終端状態など）でも停止する。
 */
export function useStaffResponse(
  receptionId: string | null,
  options?: { enabled?: boolean; intervalMs?: number },
): StaffResponseResult | null {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs ?? STAFF_RESPONSE_POLL_MS;
  const [response, setResponse] = useState<StaffResponseResult | null>(null);
  // 最新値を effect 内から参照し、ポーリングの再起動を避ける。
  // ref の更新は描画中ではなく effect で行う（react-hooks ルール準拠）。
  const responseRef = useRef<StaffResponseResult | null>(null);
  useEffect(() => {
    responseRef.current = response;
  });

  useEffect(() => {
    if (!receptionId || !enabled) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/kiosk/receptions/${receptionId}/status`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as ReceptionVisitorStatus;
        if (cancelled) return;
        if (shouldReplaceResponse(responseRef.current, data.staffResponse)) {
          setResponse(data.staffResponse ?? null);
        }
      } catch {
        /* 取得失敗はポーリングを止めない（受付フローを壊さない） */
      }
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
