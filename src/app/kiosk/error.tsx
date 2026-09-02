'use client';

/**
 * `/kiosk` 配下の未捕捉例外 (#736 Gate A)。
 *
 * 🔴 **例外の内容を来訪者へ出さない。** `error` は受け取るが画面には出さず、
 * 開発者向けにコンソールへ 1 行だけ残す（`digest` は Next が採番する識別子で PII を含まない）。
 * 出さないのは #629（origin-verify の 403 に英語の生エラーを出していた）と同じ方針。
 *
 * `reset` は Next が渡す再試行。来訪者を行き止まりにしない。
 */
import { useEffect } from 'react';
import { UnexpectedErrorScreen } from '@/components/kiosk/UnexpectedErrorScreen';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';

export default function KioskError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 画面には出さない。切り分けの手掛かりだけ残す（本文・stack は載せない）。
    console.error(JSON.stringify(unexpectedErrorLogLine('kiosk', error)));
  }, [error]);

  return <UnexpectedErrorScreen onRetry={reset} />;
}
