import { NextResponse } from 'next/server';
import { getReception, markCallFailed } from '@/lib/data-stores/reception-store';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { routingMayContinue } from '@/domain/routing/stop';

/**
 * POST /api/kiosk/receptions/:id/give-up — 端末が待つのをやめたことを伝える (#743)。
 *
 * ## なぜ要るのか
 *
 * `CALL_STATUS_POLL_MAX_MS`（5 分）に達したときの諦めは**クライアントの dispatch だけ**で、
 * サーバへ何も送っていなかった。受付は `'calling'` のまま残り、**取次は hop 上限まで
 * 進み続ける** ── iPad は諦めたのに社内の電話は鳴り続ける（「無人の呼び出し」）。
 *
 * 受付を終端させると、以降の hop は `decideRoutingStop` に弾かれる
 * （`dialNextHop` は撃つ前に受付状態を見る）。**取次を止める経路はこれ 1 本**。
 *
 * ## 何をしないか
 *
 * 🔴 **すでに鳴っている通話は切らない。** provider への切断要求は新しい外部副作用で
 * 停止境界に当たる（`.claude/rules/opus5-autonomous-loop.md`）。鳴ってしまった通話は
 * 呼出予算（`dialExpiresAt`）で自然に終わる。切断は人間承認のうえで別の増分に分ける。
 *
 * ## 端末を待たせない
 *
 * 🔴 書けなかったことを理由に端末側の遷移を止めない。ここが失敗しても来訪者にできることは
 * 無く、画面が「呼び出し中」のまま固まる方が悪い。応答は常に 200（存在しない場合を除く）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;

  const { id } = await params;
  const found = await getReception(id);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 🔴 既に終端していれば触らない。担当者が応答して `connected` になった直後に端末側の
  // 上限が来ることがあり、そこで `failed` を書くと**繋がったのに失敗になる**。
  if (!routingMayContinue(found.value.state)) {
    return NextResponse.json({ stopped: false, state: found.value.state });
  }

  const result = await markCallFailed(id, 'client_timeout');
  return NextResponse.json({ stopped: result.ok });
}
