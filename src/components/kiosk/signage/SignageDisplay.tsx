'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nextIndex } from '@/domain/signage/rotation';
import type { KioskSignage, KioskSignageItem } from '@/lib/signage/kiosk-signage';
import { SignageItemView } from './SignageItemView';

/**
 * 待機中サイネージの表示 (issue #101, increment 1)。スタンドアロン待機画面。
 *
 * 端末向け API（/api/kiosk/signage）から再生可能な項目を取得し、各項目の表示秒数で
 * 巡回する（巡回判定は純関数 nextIndex に委譲）。タップ/クリック/キー操作で /kiosk へ
 * 遷移＝受付復帰する（issue #101: タップで受付開始へ）。
 *
 * presence 連携（来訪検知での自動復帰）は import 参照に留め、実配線は次増分:
 *   - 検知状態は src/domain/presence/state.ts（PresenceState: IDLE→…→ACTIVE）が持つ。
 *   - ACTIVE 遷移（来訪検知）を受けて本コンポーネントが /kiosk へ遷移する配線を次増分で追加する。
 *   - ここでは明示操作（タップ/キー）による復帰のみを実装する。
 *
 * 受付開始の導線は常に大きく表示する（issue #101 UX 方針）。緊急停止/通信断の優先表示は
 * 次増分（kiosk/config の active と統合）。本増分は待機中の純粋なサイネージ表示に限る。
 */
export function SignageDisplay({
  tenantId = 'internal',
  siteId = 'default',
  onStart,
}: {
  tenantId?: string;
  siteId?: string;
  /**
   * 受付復帰の振る舞いを差し替えるフック (kiosk-integration inc1)。
   * - 未指定（スタンドアロン /kiosk/signage）: 既定どおり /kiosk へ遷移する（非破壊）。
   * - 指定（KioskFlow へ埋め込み）: 画面遷移せず受付状態機械の START を呼ぶ。
   */
  onStart?: () => void;
}) {
  const router = useRouter();
  const [signage, setSignage] = useState<KioskSignage | null>(null);
  const [index, setIndex] = useState(0);

  // 受付復帰: 明示操作で受付へ。連打を吸収するため一度だけ実行する。
  const returned = useRef(false);
  const returnToReception = useCallback(() => {
    if (returned.current) return;
    returned.current = true;
    if (onStart) onStart();
    else router.push('/kiosk');
  }, [router, onStart]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/kiosk/signage?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSignage(data as KioskSignage);
      })
      .catch(() => {
        /* 読み込み失敗時は待機画面を空にする（受付導線は残す）。 */
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, siteId]);

  const items = signage?.items ?? [];
  const current: KioskSignageItem | undefined = items[Math.min(index, Math.max(items.length - 1, 0))];

  // 現在項目の表示秒数で次へ進める。
  useEffect(() => {
    if (items.length <= 1 || !current) return;
    const ms = Math.max(current.durationSeconds, 3) * 1000;
    const id = setTimeout(() => setIndex((i) => nextIndex(i, items.length)), ms);
    return () => clearTimeout(id);
  }, [items.length, current]);

  // キーボードでも受付復帰できるようにする（iPad の外付けキーボード等）。
  useEffect(() => {
    const onKey = () => returnToReception();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [returnToReception]);

  return (
    <div
      data-testid="signage-display"
      role="button"
      tabIndex={0}
      onClick={returnToReception}
      onTouchStart={returnToReception}
      style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        padding: 32,
        cursor: 'pointer',
        background: 'var(--color-bg, #0b0f17)',
        color: 'var(--color-text, #fff)',
      }}
    >
      <div
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {current ? <SignageItemView item={toSignageItem(current)} /> : null}
      </div>

      {/* 受付開始の導線は常に大きく表示する（クリック/タップで /kiosk へ）。 */}
      <button
        type="button"
        data-testid="signage-start"
        onClick={(e) => {
          e.stopPropagation();
          returnToReception();
        }}
        style={{
          fontSize: 'clamp(20px, 3.5vw, 40px)',
          fontWeight: 800,
          padding: '20px 48px',
          borderRadius: 999,
          border: 'none',
          background: 'var(--color-accent, #38bdf8)',
          color: 'var(--color-bg, #0b0f17)',
          cursor: 'pointer',
        }}
      >
        画面をタップして受付を開始
      </button>
    </div>
  );
}

/** KioskSignageItem を表示コンポーネント用の SignageItem 形へ写す（id は表示に不要なダミー）。 */
function toSignageItem(item: KioskSignageItem) {
  return {
    id: 'kiosk-signage-item' as never,
    type: item.type,
    enabled: true,
    title: item.title,
    message: item.message,
    imageUrl: item.imageUrl,
    imageAlt: item.imageAlt,
    slideUrls: item.slideUrls,
    durationSeconds: item.durationSeconds,
  };
}
