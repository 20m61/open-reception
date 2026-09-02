/**
 * 実 PSTN 発信の境界 (#4 Inc D)。
 *
 * ## なぜ `ConnectionProvider` を使わないのか
 *
 * `./provider.ts` の `ConnectionProvider.connect()` は **1 手の最終結果を同期で返す**契約で、
 * mock ではそれが成立する。しかし実 PSTN では `POST /v1/calls` が返すのは
 * **「発信を受け付けた」と provider 通話 ID だけ**で、応答・DTMF・切断は**後から webhook で**
 * 届く。同じ契約に押し込むと、`connect()` の中で数十秒待つことになり HTTP リクエスト内で
 * 完結しない（#632 で「取次が同期実行だった」として顕在化した問題）。
 *
 * よって**別契約**を立て、実 PSTN は `./resumable.ts`（`startRouting` / `advanceRouting`）の
 * 非同期経路に載せる。mock 経路は `ConnectionProvider` のまま温存する ── 既存の
 * `orchestrator.ts` は同期前提なので、実 PSTN を混ぜると壊れる。
 *
 * ## 相関の順序について
 *
 * 相関キー（provider 通話 ID）は**発信してからでないと分からない**が、answer webhook は
 * その相関を引けないと 403 になる。原理的に順序が逆転しているため、発信直後に相関を書き、
 * answer 側で短時間リトライする（Inc D の設計判断）。ここはその**発信部分だけ**を持つ。
 */
import type { ConnectCommand } from './provider';

/** E.164（`+` ＋ 数字 8〜15 桁）。Vonage へ渡すときは `+` を落とす。 */
const E164 = /^\+[1-9]\d{7,14}$/;

export type CreateCallParams = {
  /** 発信先（E.164）。 */
  readonly to: string;
  /** 発信元（E.164）。Vonage で購入した番号。 */
  readonly from: string;
  /** NCCO を返すエンドポイント。**CloudFront のドメイン**であること（Function URL だと 403）。 */
  readonly answerUrl: string;
  /** 通話イベントの通知先。 */
  readonly eventUrl: string;
  /** 呼び出し（rings）のタイムアウト秒。 */
  readonly timeoutSeconds: number;
};

/** Vonage `POST /v1/calls` のリクエスト本文。Provider 固有の形はここで閉じる。 */
export type CreateCallRequest = {
  readonly to: ReadonlyArray<{ readonly type: 'phone'; readonly number: string }>;
  readonly from: { readonly type: 'phone'; readonly number: string };
  readonly answer_url: readonly string[];
  readonly answer_method: 'POST';
  readonly event_url: readonly string[];
  readonly event_method: 'POST';
  readonly ringing_timer: number;
};

/**
 * `ringing_timer` の上限（秒）。Vonage Voice API の仕様は 1〜120（既定 60）で、
 * 公式 SDK も同じ範囲で検証している（Java は例外、Python は pydantic の `le=120`）。
 *
 * 超える値をそのまま送ると 400 で**発信自体が失敗**し、来訪者は有人支援へ倒れる。
 * ルート設定（`RoutingStep.timeoutSeconds`）は端末の待ち上限（5 分）までしか検証して
 * いないので、ここで上限へ丸める。丸めた分は呼出予算（`dialExpiresAt`）より Vonage 側の
 * `timeout` webhook が先に届くだけで、取次は正しく次の手へ進む。
 */
export const VONAGE_RINGING_TIMER_MAX_SECONDS = 120;

function requireE164(value: string, field: string): string {
  if (!E164.test(value)) {
    // 値そのものは載せない（番号は PII）。どの項目かだけを伝える。
    throw new Error(`${field} must be E.164 (+ and 8-15 digits)`);
  }
  return value.slice(1);
}

function requireHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  return value;
}

/**
 * `POST /v1/calls` の本文を組み立てる。**来訪者情報を引数に取らない**（PII 境界）。
 *
 * 第 1 段の案内は answer webhook が返す NCCO 側で組み立てる。発信リクエストに PII を
 * 載せると、Vonage 側のログ・管理画面に来訪者情報が残る。
 */
export function buildCreateCallRequest(params: CreateCallParams): CreateCallRequest {
  if (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds <= 0) {
    throw new Error('timeoutSeconds must be a positive number');
  }
  return {
    to: [{ type: 'phone', number: requireE164(params.to, 'to') }],
    from: { type: 'phone', number: requireE164(params.from, 'from') },
    answer_url: [requireHttpUrl(params.answerUrl, 'answerUrl')],
    // **既定は GET**。GET だと本文が無く、signed webhook の payload_hash が成立しない。
    answer_method: 'POST',
    event_url: [requireHttpUrl(params.eventUrl, 'eventUrl')],
    event_method: 'POST',
    // 上限を超える値は 400 になる（上記）。整数であることは入力検証（`parseRoutingSteps`）が
    // 保証するが、直接呼ばれても壊れないよう切り捨てておく。
    ringing_timer: Math.min(Math.floor(params.timeoutSeconds), VONAGE_RINGING_TIMER_MAX_SECONDS),
  };
}

export type CreateCallOutcome =
  | { readonly ok: true; readonly providerCallId: string }
  | { readonly ok: false; readonly reason: 'missing_uuid' };

/**
 * `POST /v1/calls` の応答から相関キーを取り出す。
 *
 * **uuid が取れないケースを成功にしない。** ここで空文字や undefined を通すと、
 * 「発信済みなのに相関を書けない」状態になり、以後の webhook が永久に引けなくなる。
 */
export function parseCreateCallResponse(body: unknown): CreateCallOutcome {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'missing_uuid' };
  const uuid = (body as { uuid?: unknown }).uuid;
  if (typeof uuid !== 'string' || uuid.length === 0) return { ok: false, reason: 'missing_uuid' };
  return { ok: true, providerCallId: uuid };
}

/** 発信の開始結果。最終結果は webhook で後から届く。 */
export type VoiceCallInitiation = { readonly providerCallId: string };

/**
 * 実 PSTN の発信境界。`ConnectionProvider` と**意図的に別**（上のコメント参照）。
 * 1 手ぶんの発信を**開始**するだけで、結果は返さない。
 */
export interface VoiceCallInitiator {
  /** Provider 識別子。`ContactEndpoint.providerKey` と突合する。 */
  readonly key: string;
  initiate(command: ConnectCommand): Promise<VoiceCallInitiation>;
}
