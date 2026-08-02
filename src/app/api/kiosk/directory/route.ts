import { NextResponse } from 'next/server';
import { getKioskDirectory } from '@/lib/data-stores/directory-store';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/**
 * GET /api/kiosk/directory — 受付端末向けの部署・担当者一覧 (issue #3)。
 * 有効な部署・担当者の最小情報のみを返す（内部情報は含めない）。
 *
 * ## ここを組織モデル (`getVisitorDirectory`) へ一本化していない理由
 *
 * この個別 API は **`/api/configuration/effective` が落ちたときの縮退経路**
 * （`useKioskConfiguration` の `legacyConfigFetch`）。同じ導出関数へ寄せると、
 * 組織コレクション側の読み失敗で **effective も縮退経路も同時に落ちて**、来訪者が
 * 誰も選べない行き止まりになる。fallback の意味を変える判断なので、ユーザー確認まで
 * 独立した経路として旧実装のまま残す（#373 レビュー P2-4）。
 *
 * 分岐が残るぶん「API と画面で見えるものが違う」可能性はあるが、新 UI 由来の編集
 * （表示名の上書き・非公開化）が入るまで両者の出力は一致する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getKioskDirectory(defaultTenantIdFrom()));
}
