/**
 * 受付端末の**登録の証跡**（端末証明） (#1237)。
 *
 * kiosk セッション（`kiosk.ts`、30 日）は「いま受付を動かしてよい」を表し、切れたら
 * PIN 画面に戻る。PIN 画面から再認可するには「この端末は登録済み」を**セッションとは別に**
 * 示すものが要る —— セッションでそれを示すと、セッションが切れた時点で証跡も消え、
 * PIN 画面からの PIN が常に未登録扱いになる（#1263 のレビュー）。
 *
 * - エンロール（管理発行 URL/QR の消費）のときにだけ発行する。PIN 認可では発行も延長もしない
 *   （PIN だけで登録の証跡を延ばせると、登録の期限が実質無くなる）。
 * - 端末 id と**世代**（`Device.credentialGeneration`）を署名で束ねる。失効・再登録で台帳の
 *   世代が上がるので、古い証明は署名が正しくても通らない（照合は authorize 側）。
 * - 署名鍵は `KIOSK_ENROLLMENT_SECRET`（`failClosed`）。実デプロイで未設定なら発行も検証も
 *   throw する —— 公開既定値で署名された証明を受け付ける状態を作らない。新しい env を増やさない。
 *   エンロールトークンと鍵を共有するので、`role` で取り違えを断つ（`ENROLLMENT_ROLE` と同じ流儀）。
 * - cookie は HttpOnly・path を authorize に限る（他の要求に載せない）。値はログ・応答本文に出さない。
 */
import { signSession, verifySession } from './session';
import { getEnrollmentSecret } from './kiosk-enrollment';

export const KIOSK_DEVICE_COOKIE = 'kiosk_device';
/** 保持期間（1 年。owner 判断）。過ぎたら管理発行 URL/QR で登録し直す。 */
export const KIOSK_DEVICE_CREDENTIAL_TTL_MS = 1000 * 60 * 60 * 24 * 365;
/** 証明を使うのは PIN 認可だけなので、cookie もそこへしか送らせない。 */
export const KIOSK_DEVICE_COOKIE_PATH = '/api/kiosk/authorize';

/** kiosk セッション（'kiosk'）・エンロール（'kiosk-enroll'）と取り違えないための専用 role。 */
const DEVICE_CREDENTIAL_ROLE = 'kiosk-device';

export type DeviceCredential = { kioskId: string; generation: number };

export async function issueDeviceCredential(
  kioskId: string,
  generation: number,
  now: number = Date.now(),
): Promise<string> {
  return signSession(
    { role: DEVICE_CREDENTIAL_ROLE, exp: now + KIOSK_DEVICE_CREDENTIAL_TTL_MS, kioskId, generation },
    getEnrollmentSecret(),
  );
}

/**
 * 署名・期限・role・形を検証して取り出す。満たさなければ null。
 * 🔴 鍵が解決できないときは throw する（呼び出し側が 503 へ倒す。null にすると「未登録」に化ける）。
 */
export async function readDeviceCredential(
  token: string | undefined,
): Promise<DeviceCredential | null> {
  if (!token) return null;
  const payload = await verifySession(token, getEnrollmentSecret());
  if (!payload || payload.role !== DEVICE_CREDENTIAL_ROLE) return null;
  const { kioskId, generation } = payload;
  if (typeof kioskId !== 'string' || kioskId.trim() === '') return null;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return null;
  return { kioskId, generation };
}
