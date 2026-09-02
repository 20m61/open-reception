/**
 * リアルタイム基盤の可用性から「音声受付を提示してよいか」を決める純ロジック
 * (issue #366 / `docs/adr/0003-realtime-runtime-ec2-phase0.md` の ADR-005)。
 *
 * ADR-005 の要求:
 *   - **ready 判定（`/health/ready` 相当）が通るまでは音声受付を利用可能と表示しない**
 *   - EC2/ASG の異常時は degraded として扱い、iPad Kiosk はタッチ・QR へフォールバックする
 *     （サイネージ・管理・QR は WebStack 側で独立して動くため受付自体は止まらない）
 *
 * `lifecycle.ts` との違い: あちらは**接続を試みたあと**の状態（切断・再接続・断念）を持つ。
 * 本モジュールは**接続を試みる前**に「そもそも基盤が受け付けられるか」を決める。関心事が
 * 別なので状態機械は分ける。ただし判定は両方を見る — 接続を使い果たしていれば基盤が
 * ready でも提示しない。
 *
 * **設計の指針: 不確かなときは提示しない。** できると言って実際にできないことを来訪者に
 * 見せない（#481 で `inputModes` の宣言を実態に合わせたのと同じ原則）。
 *
 * 基盤本体（EC2 上の realtime gateway）は未実装で、`/health/ready` を返す実体はまだ無い。
 * 本モジュールは interface + mock 先行の「interface」側で、実物が立ったら状態の供給元が
 * 差し替わるだけで判定ロジックは動かない。実機検証は #65。
 */
import type { VoiceTransportLifecycleState } from './lifecycle';

/**
 * リアルタイム基盤の稼働状態。供給元は運用状態 API（未実装）または demo harness の
 * シナリオ（`DEMO_RUNTIME_STATES`）。
 *
 * - ready: `/health/ready` が通っている。音声受付を受け付けられる。
 * - starting: ASG が起動中 / アプリ起動待ち。すぐ使えるようになる見込み。
 * - stopped: 営業時間外の正常な停止（ASG DesiredCapacity=0）。異常ではない。
 * - degraded: instance crash / health check 失敗。復旧まで使えない。
 * - unknown: 状態を取得できない（API 到達不可・応答不正）。**fail-safe で使えない扱い**。
 */
export const REALTIME_RUNTIME_STATUSES = [
  'ready',
  'starting',
  'stopped',
  'degraded',
  'unknown',
] as const;

export type RealtimeRuntimeStatus = (typeof REALTIME_RUNTIME_STATUSES)[number];

/**
 * 端末に見せる音声受付の可用性。
 *
 * `preparing` と `unavailable` を分けているのは案内文言が違うため。準備中は「もうすぐ使える」、
 * 利用不可は「今回はタッチでお願いします」。どちらも**音声を提示しない**点は同じ
 * （`isVoicePresentable` が唯一の判定点）。
 */
export type VoiceAvailability = 'available' | 'preparing' | 'unavailable';

/**
 * 音声受付の可用性を決める。
 *
 * @param input.runtime   基盤の稼働状態。
 * @param input.transport 接続 lifecycle の状態。未指定＝まだ接続を試みていない。
 */
export function resolveVoiceAvailability(input: {
  runtime: RealtimeRuntimeStatus;
  transport?: VoiceTransportLifecycleState;
}): VoiceAvailability {
  // 接続を使い果たしている（lifecycle の degraded）なら、基盤の状態に関わらず提示しない。
  // 基盤が健全でも端末から届かないため、「準備中」と言って待たせるのも誤り。
  if (input.transport === 'degraded') return 'unavailable';

  switch (input.runtime) {
    case 'ready':
      return 'available';
    case 'starting':
      return 'preparing';
    case 'stopped':
    case 'degraded':
      return 'unavailable';
    case 'unknown':
      // 状態を知らないまま「使えます」とは言わない。preparing にすると永久に準備中と
      // 表示し続けて来訪者を待たせるため、タッチへ寄せる。
      return 'unavailable';
  }
}

/**
 * 音声受付を提示してよいか。**`available` のときだけ true**。
 *
 * ADR-005 の「ready 判定が通るまでは音声受付を利用可能と表示しない」を 1 箇所に閉じ込める。
 * 呼び出し側が `!== 'unavailable'` のような判定を書くと `preparing` を取りこぼすため、
 * 判定はこの関数に集約する。
 */
export function isVoicePresentable(availability: VoiceAvailability): boolean {
  return availability === 'available';
}
