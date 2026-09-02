/**
 * Vonage Voice API への切断 adapter (#743 AC2 後半)。
 *
 * `src/domain/routing/voice-terminator.ts` の `VoiceCallTerminator` を実装する
 * （発信 `VoiceCallInitiator` とは**別契約**。理由はそちらの doc コメント）。
 *
 * ## API の形（issue 本文は誤っていた）
 *
 * 🔴 **`DELETE /v1/calls/{uuid}` は存在しない。** #743 の Decision Packet はそう書いていたが、
 * Voice API リファレンスに DELETE のエンドポイントは無く、進行中の通話への操作は
 * **`PUT /v1/calls/{uuid}` + `{"action": "..."}`** ただ 1 つ（mute / unmute / earmuff /
 * transfer / hangup が同じ形を共有する）。DELETE で実装すると 404 が返り、
 * `already_ended` と区別が付かないまま**「切ったつもりで鳴り続ける」**ことになる ──
 * しかもそれに気づけるのは実資格情報が入った後（#65）。
 *
 * ## 依存はすべて注入する
 *
 * `vonage-voice-initiator.ts` と同じ理由（実資格情報・実 HTTP はゲートで動かせない）。
 */
import {
  terminationOutcomeFromStatus,
  type VoiceCallTerminator,
  type VoiceTerminationOutcome,
} from '@/domain/routing/voice-terminator';
import { VONAGE_VOICE_PROVIDER_KEY, type VonageVoiceCredentials } from './vonage-voice-initiator';

export type VonageVoiceTerminatorDeps = {
  /**
   * 切断に要るのは `applicationId` と `privateKeyPem`（JWT 署名）だけで、`fromNumber` は
   * 使わない。それでも発信と同じ型を受けるのは、**切る相手は必ず自分が撃った通話**であり、
   * その時点で `fromNumber` は揃っているため（解決経路を 2 つに割らない）。
   */
  credentials: () => Promise<VonageVoiceCredentials>;
  signJwt: (params: { applicationId: string; privateKeyPem: string }) => string;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
};

/**
 * 切断要求の上限。
 *
 * 🔴 **上限のない切断をしない。** 呼び出し元は webhook ハンドラと端末の `/give-up` で、
 * どちらも待たせてよい相手ではない（webhook は NCCO 応答の予算 #744 を共有し、
 * `/give-up` は「画面を固まらせない」ことが要件）。発信の上限より短く取る ──
 * 切断は**失敗しても呼出予算で自然に終わる**ので、待つ価値が発信より小さい。
 */
export const VONAGE_HANGUP_REQUEST_TIMEOUT_MS = 2_000;

export function createVonageVoiceTerminator(
  deps: VonageVoiceTerminatorDeps,
): VoiceCallTerminator {
  return {
    key: VONAGE_VOICE_PROVIDER_KEY,

    async terminate(providerCallId: string): Promise<VoiceTerminationOutcome> {
      // 空の通話 ID で API を叩かない（`/v1/calls/` はコレクション側の URL になる）。
      if (providerCallId.length === 0) return { kind: 'failed' };

      const creds = await deps.credentials();
      const jwt = deps.signJwt({
        applicationId: creds.applicationId,
        privateKeyPem: creds.privateKeyPem,
      });

      let res: Response;
      try {
        res = await deps.fetch(
          new URL(`/v1/calls/${encodeURIComponent(providerCallId)}`, deps.baseUrl).toString(),
          {
            method: 'PUT',
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'hangup' }),
            signal: AbortSignal.timeout(VONAGE_HANGUP_REQUEST_TIMEOUT_MS),
          },
        );
      } catch {
        // 🔴 例外を投げ返さない。呼び出し元は webhook ルートと端末ルートで、
        // どちらも切断の失敗で 5xx を返してはいけない（再送・画面固着を招く）。
        // 例外の中身も載せない（宛先・URL・資格情報が混ざりうる）。
        return { kind: 'failed' };
      }

      return terminationOutcomeFromStatus(res.status);
    },
  };
}
