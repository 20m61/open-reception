/**
 * デモの sandbox 境界 (issue #363 Increment 1・最重要 AC)。
 *
 * Demo Harness は本番 Kiosk コンポーネントを iframe 内で動かし、その iframe の `window.fetch` を
 * Mock Adapter（`./mock-adapter.ts`）へ差し替える。本モジュールはその Mock Adapter が
 * 「どのリクエストを許可するか」を **fail-closed**（既定拒否）で判定する純ロジック。
 *
 * 許可するのは **同一オリジンの `/api/kiosk/*`** のみ。それ以外（本番集計 `/api/admin/*`・
 * `/api/platform/*`、Vonage 等クロスオリジンの発信先、未知パス）はすべて `DemoSandboxViolation`
 * を throw する。これにより「デモが本番 API・Vonage 発信・本番集計を実行しない」不変条件を、
 * Mock Adapter がグローバル fetch を一切参照しないこと（実ネットワークへ出る経路が存在しない）と
 * 合わせて構造的に保証する。
 */

/** sandbox 境界の違反。ブロックした URL を保持する（機微値は含めない前提の内部 API パス/公開 URL のみ）。 */
export class DemoSandboxViolation extends Error {
  readonly blockedUrl: string;
  constructor(blockedUrl: string) {
    super(`demo sandbox: blocked non-mock request: ${blockedUrl}`);
    this.name = 'DemoSandboxViolation';
    this.blockedUrl = blockedUrl;
  }
}

/** デモで Mock が肩代わりしてよい唯一の API プレフィックス。 */
export const DEMO_ALLOWED_PATH_PREFIX = '/api/kiosk/';

/**
 * リクエスト URL がデモ sandbox で許可されるかを判定し、許可なら pathname+search を返す。
 * 許可されないものは `DemoSandboxViolation` を throw する（既定拒否）。
 *
 * @param rawUrl 相対（`/api/kiosk/...`）または絶対 URL。
 * @param origin iframe（デモページ）のオリジン。相対 URL の解決と同一オリジン判定に使う。
 */
export function assertDemoRequestAllowed(rawUrl: string, origin: string): string {
  let resolved: URL;
  try {
    resolved = new URL(rawUrl, origin);
  } catch {
    throw new DemoSandboxViolation(rawUrl);
  }
  // クロスオリジン（Vonage 等・別スキーム・別ホスト）は一律遮断。
  if (resolved.origin !== new URL(origin).origin) {
    throw new DemoSandboxViolation(rawUrl);
  }
  // `/api/kiosk/` 配下のみ。パストラバーサルは URL 正規化後の pathname で弾かれる。
  if (!resolved.pathname.startsWith(DEMO_ALLOWED_PATH_PREFIX)) {
    throw new DemoSandboxViolation(rawUrl);
  }
  return resolved.pathname + resolved.search;
}

/** throw せず boolean で許可判定する版（表示制御・テスト用）。 */
export function isDemoAllowedUrl(rawUrl: string, origin: string): boolean {
  try {
    assertDemoRequestAllowed(rawUrl, origin);
    return true;
  } catch {
    return false;
  }
}
