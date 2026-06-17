import { NextResponse } from 'next/server';
import { getKioskDirectory } from '@/lib/mock-backend/directory-store';

/**
 * GET /api/kiosk/directory — 受付端末向けの部署・担当者一覧 (issue #3)。
 * 有効な部署・担当者の最小情報のみを返す（内部情報は含めない）。
 */
export function GET(): NextResponse {
  return NextResponse.json(getKioskDirectory());
}
