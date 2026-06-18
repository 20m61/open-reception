import { NextResponse } from 'next/server';
import { getKioskMotions } from '@/lib/motion/motion-store';

/**
 * GET /api/kiosk/motions — 受付端末向けの状態別モーション URL (issue #31)。
 * VRM レンダラ（#5）が受付状態に応じて再生するために消費する。未設定/失敗時は default に fallback。
 */
export function GET(): NextResponse {
  return NextResponse.json(getKioskMotions());
}
