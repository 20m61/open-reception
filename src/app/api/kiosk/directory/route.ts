import { NextResponse } from 'next/server';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { getVisitorDirectoryForFallback } from '@/lib/organization/organization-service';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/**
 * GET /api/kiosk/directory — 受付端末向けの部署・担当者一覧 (issue #3)。
 * 有効な部署・担当者の最小情報のみを返す（内部情報は含めない）。
 *
 * ## 導出は組織モデルへ一本化してある（#597）
 *
 * かつてここだけ旧実装（組織モデルを読まない）だった。#588 の時点では新 UI 由来の編集が
 * 存在せず両者の出力が一致したので実害が無かったが、#373 増分 5/6 で編集経路が実在した結果、
 * **構成取得が落ちている間だけ、運用者が「来訪者に出さない」と設定した組織が再び出る**
 * 状態になった。管理画面は「見えない」と表示しているので運用者からは気づけない。
 *
 * とはいえ `getVisitorDirectory` をそのまま使うと、組織コレクションの読み失敗で
 * **実効構成も縮退経路も同時に落ちて**来訪者が誰も選べなくなる。そこで
 * `getVisitorDirectoryForFallback` を使う ——「保存済み組織を読めないときだけ互換由来へ
 * 縮退する」導出で、受付を止めずに fail-open の範囲を狭める（縮退時はログに残る）。
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
  return NextResponse.json(
    await getVisitorDirectoryForFallback({ kind: 'tenant', tenantId: defaultTenantIdFrom() }),
  );
}
