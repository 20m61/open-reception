/**
 * provider webhook の停止スイッチ (issue #4 Inc D-2 項目 7)。
 *
 * `/api/providers/vonage/**` の 4 本は**認証を持たない公開エンドポイント**（正当性は
 * 署名で担保する）。実 PSTN 発信を有効にすると、外部から叩ける口の向こうで**電話が鳴る**。
 * 異常時に配線を切る手段が無いまま実送信を有効にしない、というのがこのスイッチの理由。
 *
 * ## なぜ 403 ではなく 503 か
 *
 * 同ディレクトリの `vonage-webhook-route.ts` は「拒否は常に同一の 403」で、理由による
 * 差で通話の存在が漏れないようにしている。停止スイッチは**個別の通話に依存しない**
 * （全員に同じ応答）ので、存在は漏れない。
 *
 * むしろ 403 にしてはいけない: Vonage は 4xx を**恒久的失敗**として扱い再送を諦めるが、
 * 5xx なら後で再送する。停止は一時的な運用操作なので、復旧後にイベントを取り戻せる
 * 5xx でなければならない。
 *
 * ## なぜ env か
 *
 * DynamoDB 由来の設定にすると、**止めたい状況（データ層の異常・高負荷）でこそ読めない**。
 * 止めるための判断材料が止まっている対象に依存してはいけない。env なら再デプロイ
 * （または Lambda 環境変数の更新）だけで、アプリの他の経路に触れず切れる。
 *
 * **server-only**。`NEXT_PUBLIC_` を付けないこと（運用状態を bundle に出さない）。
 */
import { NextResponse } from 'next/server';

/** 真値として受ける表記。運用者が書き間違えても「有効になっていない」に倒す。 */
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * provider webhook 全体が停止されているか。
 *
 * **既定は false（稼働）。** 未設定・空文字・想定外の値はすべて「停止していない」。
 * 空文字を「設定済み」と読むと、意図せず全断する（[[lesson-empty-string-means-unknown]]
 * の逆向き。ここは停止側が危険なので既定を稼働に倒す）。
 */
export function providerWebhooksDisabled(): boolean {
  const raw = process.env.PROVIDER_WEBHOOKS_DISABLED;
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * 停止中の応答。**本文で理由を語らない**（拒否応答と同じ方針）が、
 * 再送してほしいので 503 と `Retry-After` を返す。
 */
export function providerWebhooksDisabledResponse(): NextResponse {
  return new NextResponse('unavailable', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '60',
    },
  });
}

/**
 * 停止中なら応答を、稼働中なら undefined を返す。各 route の**最初の 1 行**で使う。
 *
 * 署名検証より**前**に置くこと。止めたい状況では検証の計算すらさせない。
 */
export function denyIfProviderWebhooksDisabled(): NextResponse | undefined {
  return providerWebhooksDisabled() ? providerWebhooksDisabledResponse() : undefined;
}
