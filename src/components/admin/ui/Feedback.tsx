'use client';

import { useCallback, useState } from 'react';
import { color as colorTokens, font } from './tokens';

/**
 * 管理画面 共有 保存フィードバック プリミティブ (issue #330 item6)。
 *
 * 各 *Manager がそれぞれ独自に持っていた「保存しました」表示（見た目もばらばら・失敗時に
 * 何も出ないものが多い）を 1 箇所に正準化する。
 *
 *  - `useSaveFeedback` … 保存操作の結果（成功/失敗）を状態として持つ薄いフック。
 *    保存開始時に `clear()`、成功時に `success()`、失敗時に `failure()` を呼ぶだけでよい。
 *  - `SaveFeedback` … 上記の状態を描画する。成功は `role="status"` / `aria-live="polite"`、
 *    失敗は `role="alert"` / `aria-live="assertive"` にし、スクリーンリーダーにも確実に届ける。
 *
 * 既存 testid（`brand-saved` 等）は各呼び出し側から `successTestId` / `errorTestId` として
 * そのまま渡せるため、移行による e2e の破壊を避けられる。
 */
export type FeedbackStatus = 'success' | 'error';

export type SaveFeedbackState = { status: FeedbackStatus; message: string } | null;

/** ステータス → 見た目・a11y ロールの対応（純関数・テスト対象）。 */
export function feedbackMeta(status: FeedbackStatus): {
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  color: string;
} {
  return status === 'error'
    ? { role: 'alert', ariaLive: 'assertive', color: colorTokens.danger }
    : { role: 'status', ariaLive: 'polite', color: colorTokens.success };
}

/**
 * 保存操作の結果状態を管理する薄いフック。
 * 既定メッセージは「保存しました」「保存に失敗しました。」だが呼び出し側で上書きできる。
 */
export function useSaveFeedback(): {
  feedback: SaveFeedbackState;
  success: (message?: string) => void;
  failure: (message?: string) => void;
  clear: () => void;
} {
  const [feedback, setFeedback] = useState<SaveFeedbackState>(null);

  const success = useCallback((message = '保存しました') => {
    setFeedback({ status: 'success', message });
  }, []);
  const failure = useCallback((message = '保存に失敗しました。') => {
    setFeedback({ status: 'error', message });
  }, []);
  const clear = useCallback(() => setFeedback(null), []);

  return { feedback, success, failure, clear };
}

/** `useSaveFeedback` の状態を描画する共有プリミティブ。 */
export function SaveFeedback({
  feedback,
  successTestId,
  errorTestId,
}: {
  feedback: SaveFeedbackState;
  /** 成功時に付与する data-testid（既存 testid との互換用）。 */
  successTestId?: string;
  /** 失敗時に付与する data-testid。 */
  errorTestId?: string;
}) {
  if (!feedback) return null;
  const meta = feedbackMeta(feedback.status);
  return (
    <span
      data-testid={feedback.status === 'error' ? errorTestId : successTestId}
      role={meta.role}
      aria-live={meta.ariaLive}
      style={{ color: meta.color, fontSize: font.small, fontWeight: 600 }}
    >
      {feedback.message}
    </span>
  );
}
