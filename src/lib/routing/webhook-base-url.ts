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

/**
 * **発信コールバック用**の基底オリジン (#646)。
 *
 * `resolveWebhookBaseUrl` と分けてあるのは、**あちらが必ず非空を返す**から。
 * 最後の手段の `request.url` は OpenNext/Lambda では Function URL になりうるので、
 * それを Vonage へ渡すと当該通話の webhook が全部 origin-verify の 403 になり、
 * **鳴らしたのに一切進まない通話**が残る（#612 と同型）。
 *
 * 「分からないなら撃たない」を成立させるには、**分からないことを表現できる型**が要る。
 * よって明示設定と `x-forwarded-host` だけを採り、無ければ `undefined` を返す。
 *
 * 🔴 1 手目（`call-execution.ts` の `webhookBaseUrl`）はまだ `resolveWebhookBaseUrl` を
 * 使っている。同じ穴を持つが、寄せると 1 手目の挙動が変わるので別に扱う。
 */
export function resolveDialCallbackBaseUrl(request: Request): string | undefined {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured;

  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${forwarded}`;
  }
  return undefined;
}
