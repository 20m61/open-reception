import { NextResponse } from 'next/server';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
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
 *
 * ## kiosk セッション必須 (#589)
 *
 * 他の kiosk API（voice / motions / assets / flow / checkin / checkout …）は #239 で
 * セッション必須になったが、ここだけ取り残されていた。**匿名で叩けば在席者名簿が取れる**
 * 状態で、組織モデルへの書き込み経路が入ると読める範囲は「Department 実体のある部署」から
 * 「`publicInDirectory: true` の全組織」へ広がる。露出面を広げる前に塞ぐ。
 *
 * 縮退経路は壊れない。この API を叩くのは `/kiosk` 画面の `legacyConfigFetch` で、
 * `/kiosk` 自体が #239 でセッション必須になっている。**セッションを持つ端末が構成取得に
 * 失敗した**という状況で使うものなので、セッションを要求しても逃げ道は塞がらない。
 */
export async function GET(): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  return NextResponse.json(await getKioskDirectory(defaultTenantIdFrom()));
}
