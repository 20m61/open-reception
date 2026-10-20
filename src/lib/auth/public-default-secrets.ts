/**
 * 公開既定値を**明示的に貼った**デプロイを起動時に止める (#1124 / PR #1273 レビュー important)。
 *
 * `serverSecret()` は deploy 環境で「公開既定値と同じ値」を未設定として扱い、fail-closed の鍵は
 * throw する。セッション鍵 2 つは `session-secrets.ts` が起動時に検査するが、残りの fail-closed
 * 鍵は**使った時点で**落ちるだけだった（例: `ADMIN_PASSWORD=open-reception` ならログインが
 * 500 になるまで気づけない）。ここでは「既定値を貼った」ことだけを起動時に止める。
 *
 * 🔴 **未設定は止めない。** これらは機能・provider によって不要なことがある
 * （`ADMIN_PASSWORD` は provider=none のときだけ使う。`PLATFORM_ELEVATION_SECRET` /
 * `VOICE_TRANSPORT_TOKEN_SECRET` は手順書の必須一覧にも無い）。未設定で起動を止めると、
 * いま動いているデプロイ全体が落ちる。未設定は従来どおり getter が使う時点で fail-closed。
 * 既定値を貼る正当な理由は無いので、こちらは機能を問わず止めてよい。
 *
 * 🔴 判定は getter をそのまま呼ぶ（`session-secrets.ts` と同じ流儀）。既定値の文字列を
 * ここへ写すと、getter と検査が別の述語になってずれる。値が入っている鍵だけ getter を呼べば、
 * throw するのは「deploy で公開既定値と一致」のときに限られる。
 *
 * 🔴 鍵を足したら**ここにも載せる**。載せ忘れは `public-default-secrets.test.ts` の棚卸しが拾う。
 */
import { getAdminPassword } from './admin';
import { getEnrollmentSecret } from './kiosk-enrollment';
import { getAnswerSecret } from '@/lib/call/answer-token';
import { elevationSecret } from '@/lib/platform/elevation';
import { getVoiceTransportTokenSecret } from '@/lib/voice-transport/token';

export const PUBLIC_DEFAULT_CHECKED_KEYS: ReadonlyArray<{ env: string; get: () => string }> = [
  { env: 'ADMIN_PASSWORD', get: getAdminPassword },
  { env: 'KIOSK_ENROLLMENT_SECRET', get: getEnrollmentSecret },
  { env: 'CALL_ANSWER_SECRET', get: getAnswerSecret },
  { env: 'PLATFORM_ELEVATION_SECRET', get: elevationSecret },
  { env: 'VOICE_TRANSPORT_TOKEN_SECRET', get: getVoiceTransportTokenSecret },
];

/** deploy 環境で公開既定値を貼った鍵があれば throw する。未設定・ローカルでは何もしない。 */
export function assertNoPublicDefaultSecrets(): void {
  for (const { env, get } of PUBLIC_DEFAULT_CHECKED_KEYS) {
    if (process.env[env]) get();
  }
}
