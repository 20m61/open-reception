/**
 * Vonage Voice API への発信 adapter (#4 Inc D)。
 *
 * `src/domain/routing/voice-initiator.ts` の `VoiceCallInitiator` を実装する
 * （`ConnectionProvider` とは**別契約**。理由はそちらの doc コメント）。
 *
 * ## 依存はすべて注入する
 *
 * 実資格情報・実 HTTP はローカルのゲートでは動かせないので、`fetch` / 資格情報 / JWT 署名 /
 * 宛先解決を注入可能にして、**実物なしで境界の振る舞いを固定する**（CLAUDE.md「interface +
 * mock 先行」）。実物を要する検証は #65。
 *
 * ## 既存の Vonage 実装との関係
 *
 * `src/adapters/call/vonage-session.ts` は **Vonage Video API**（遠隔顔合わせ）で、
 * これとは**別製品・別トラック**。共有するのはアプリ JWT の署名（`./vonage-jwt.ts`）だけ。
 */
import {
  buildCreateCallRequest,
  parseCreateCallResponse,
  type VoiceCallInitiation,
  type VoiceCallInitiator,
} from '@/domain/routing/voice-initiator';
import type { ConnectCommand } from '@/domain/routing/provider';

/** 発信に必要な資格情報。**値はログにもエラーにも出さない**。 */
export type VonageVoiceCredentials = {
  readonly applicationId: string;
  readonly privateKeyPem: string;
  /** Vonage で購入した発信元番号（E.164）。 */
  readonly fromNumber: string;
};

export type VonageVoiceDeps = {
  /** `EndpointRef` から実際の電話番号（E.164）を解決する。見つからなければ undefined。 */
  resolveNumber: (endpointId: string) => Promise<string | undefined>;
  credentials: () => Promise<VonageVoiceCredentials>;
  signJwt: (params: { applicationId: string; privateKeyPem: string }) => string;
  /** Vonage API の基底 URL。 */
  baseUrl: string;
  /**
   * webhook の基底 URL。**CloudFront のドメインであること。**
   * Function URL を渡すと `x-origin-verify` が付かず全 webhook が 403 になる。
   */
  webhookBaseUrl: string;
  fetch: typeof globalThis.fetch;
};

export const VONAGE_VOICE_PROVIDER_KEY = 'vonage-voice';

/**
 * 応答本文をそのままエラーへ載せない。
 *
 * Vonage の 4xx 本文は基本的に秘密を含まないが、**リクエストをそのまま echo する実装が
 * 将来入ると JWT が混ざりうる**。status だけを載せ、本文は落とす（診断はサーバログ側で行う）。
 */
function requestFailed(status: number): Error {
  return new Error(`vonage voice: create call failed (status ${status})`);
}

export function createVonageVoiceInitiator(deps: VonageVoiceDeps): VoiceCallInitiator {
  return {
    key: VONAGE_VOICE_PROVIDER_KEY,

    async initiate(command: ConnectCommand): Promise<VoiceCallInitiation> {
      // **宛先が解決できないなら発信しない。** 解決失敗を握り潰して発信すると、
      // 誤った宛先や発信元番号へ繋がる余地が出る。
      const to = await deps.resolveNumber(command.endpoint.id);
      if (to === undefined) {
        throw new Error(`vonage voice: endpoint not resolvable (${command.endpoint.id})`);
      }

      const creds = await deps.credentials();
      const body = buildCreateCallRequest({
        to,
        from: creds.fromNumber,
        answerUrl: new URL('/api/providers/vonage/answer', deps.webhookBaseUrl).toString(),
        eventUrl: new URL('/api/providers/vonage/events', deps.webhookBaseUrl).toString(),
        timeoutSeconds: command.timeoutSeconds,
      });

      const jwt = deps.signJwt({
        applicationId: creds.applicationId,
        privateKeyPem: creds.privateKeyPem,
      });

      const res = await deps.fetch(new URL('/v1/calls', deps.baseUrl).toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw requestFailed(res.status);

      // 応答が JSON でないこともある（プロキシのエラーページ等）。落として同じ扱いにする。
      const parsed = parseCreateCallResponse(await res.json().catch(() => null));
      if (!parsed.ok) {
        // 🔴 ここを握り潰すと「発信済みなのに相関を書けない」状態になり、以後の webhook が
        // 永久に引けなくなる（4 ルートとも 403）。必ず失敗として上へ返す。
        throw new Error('vonage voice: response has no call uuid');
      }
      return { providerCallId: parsed.providerCallId };
    },
  };
}
