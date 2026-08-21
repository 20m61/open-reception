import { NextResponse } from 'next/server';
import { getReception, markCallFailed } from '@/lib/data-stores/reception-store';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { routingMayContinue } from '@/domain/routing/stop';
import { hangUpIfRinging } from '@/lib/routing/hang-up';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

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
 * ## 鳴っている通話も切る（2026-08-21 のユーザー判断）
 *
 * 受付を終端させても、**既に鳴り始めた通話はそのまま鳴り続ける**（呼出予算が経過するまで）。
 * 担当者は出てしまい、そこに来訪者は居ない ──「無人の呼び出し」。よって切断要求も出す。
 *
 * 🔴 **切断は best-effort。失敗しても応答を変えない。** 受付を止める判断はもう済んでおり、
 * 切断はその後始末でしかない。失敗したら呼出予算で自然に終わる（＝以前の挙動に戻るだけで
 * 悪化しない）。ここで失敗を理由に 5xx を返すと、端末の画面が「呼び出し中」で固まる。
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

  // 🔴 **受付を止めてから切る。** 逆順にすると、切断の webhook（`completed`）が
  // 受付がまだ `'calling'` のうちに届き、取次が「次の手へ進む」と判断しうる。
  // テナントは `/call` と同じ scope 解決から取る（受付レコードは tenantId を持たない）。
  //
  // 🔴 **ここでも握る。** `hangUpIfRinging` は投げない契約だが、その保証はモジュールを
  // またいだ約束でしかない。端末を固まらせないことはこのルート自身の要件なので、
  // 境界でもう一度受ける（このリポジトリが繰り返し踏んでいる「配線が縛られていない」型）。
  await hangUpIfRinging(String(resolveDefaultScope().tenantId), found.value.providerCallId).catch(
    () => undefined,
  );

  return NextResponse.json({ stopped: result.ok });
}
