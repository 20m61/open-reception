/**
 * Vonage Voice webhook 本文の読み取り (issue #4 / 2026-09-02 仕様照合)。
 *
 * **Vonage が送る本文の形を知っている場所はここだけ**にする。以前は `uuid` を
 * `vonage-webhook-context.ts`、`status` を `/events`、`dtmf.digits` を `/dtmf` と `/choice` が
 * それぞれ別々に JSON.parse していた。分かれていると、フィールドを 1 つ足す（今回の
 * `region_url`）たびに全部へ手を入れることになり、いつか 1 本だけ読み方が違う形になる。
 *
 * 読むのは**署名済み本文**だけ（`payload_hash` の対象）。URL のクエリは読まない。
 *
 * 返す値は**非機微の識別子と定型値のみ**（通話 ID・状態・押された数字・API 基底 URL）。
 * `to` / `from`（電話番号＝PII）は読まない ── 読める形にすると、いつか誰かがログへ載せる。
 *
 * 純関数。投げない（壊れた本文は「何も読めなかった」＝全項目 undefined）。
 */
import { isVonageCallStatus, type VonageCallStatus } from '@/domain/call/voice-call-state';

export type VonageWebhookBody = {
  /** `uuid`。provider 側の通話 ID（相関を引く鍵）。 */
  readonly providerCallId?: string;
  /** `status`。既知の通話ステータスだけ（未知の値は undefined＝無視）。 */
  readonly status?: VonageCallStatus;
  /** `dtmf.digits`。input アクションの結果。 */
  readonly dtmfDigits?: string;
  /**
   * `region_url`。**この通話を制御する REST の基底 URL**（例: `https://api-ap-3.vonage.com`）。
   *
   * Vonage は通話ごとに所属リージョンを決め、切断などの制御はそのリージョンの
   * エンドポイントへ送るよう案内している。グローバルの `api.nexmo.com` でも届くが
   * 経路が伸びる。切断は 2 秒の予算しかない（`VONAGE_HANGUP_REQUEST_TIMEOUT_MS`）ので、
   * 分かっているなら近い方へ撃つ。
   *
   * 🔴 **許可リストで濾す。** 本文は署名済みだが、signature secret が漏れた世界では
   * ここが「JWT 付きリクエストを任意ホストへ向けさせる口」になる。`https` かつ
   * Vonage のドメイン（`*.vonage.com` / `*.nexmo.com`）以外は捨てる。
   */
  readonly regionUrl?: string;
};

const VONAGE_API_HOST = /(^|\.)(vonage\.com|nexmo\.com)$/;

/** `region_url` として受け入れてよい値か。origin だけを返す（パス・クエリは落とす）。 */
export function acceptRegionUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  if (!VONAGE_API_HOST.test(parsed.hostname)) return undefined;
  return parsed.origin;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function parseVonageWebhookBody(rawBody: string): VonageWebhookBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {};
  }
  const body = asObject(parsed);
  if (body === undefined) return {};

  const dtmf = asObject(body.dtmf);
  const status = body.status;
  const digits = dtmf === undefined ? undefined : dtmf.digits;

  return {
    ...(nonEmptyString(body.uuid) !== undefined ? { providerCallId: body.uuid as string } : {}),
    ...(isVonageCallStatus(status) ? { status } : {}),
    ...(typeof digits === 'string' ? { dtmfDigits: digits } : {}),
    ...(acceptRegionUrl(body.region_url) !== undefined
      ? { regionUrl: acceptRegionUrl(body.region_url) as string }
      : {}),
  };
}
