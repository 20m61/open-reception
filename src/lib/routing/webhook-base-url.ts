/**
 * Vonage へ渡すコールバック URL の基底オリジン (issue #4 MVP 1)。
 *
 * **`request.url` を直接使ってはいけない。** OpenNext/Lambda では Function URL の
 * ホスト（`...lambda-url...on.aws`）になりうる。そこを Vonage が叩くと CloudFront を
 * 迂回するため `src/proxy.ts` の origin-verify に落ちて 403 になり、DTMF 導線が丸ごと死ぬ。
 * 発行 URL（QR）で同じ事故が実際に起きている（#612 / deploy-aws.md「publicOriginOverride」）。
 *
 * 優先順位は受付 URL の `resolveCheckinBaseUrl` と同じ考え方に揃える:
 *   1. 明示設定（`NEXT_PUBLIC_APP_URL`）
 *   2. `x-forwarded-host`（CloudFront が付ける実ホスト）
 *   3. `request.url`（最後の手段。ローカル開発用）
 */
export function resolveWebhookBaseUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured;

  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${forwarded}`;
  }
  return request.url;
}
