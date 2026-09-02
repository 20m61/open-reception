/**
 * 実 PSTN 発信者の解決 (#4 Inc D-2 項目 2)。
 *
 * `resolveProviderForTenant` は「このテナントは vonage か mock か」までを決めるが、
 * **実発信にはそれだけでは足りない**（発信元番号・秘密鍵・application id が要る）。
 * ここはその最後の一段を担い、**1 つでも欠けていたら null を返す**。
 *
 * ## なぜ fail-closed か
 *
 * 欠けたまま発信者を組み上げると、資格情報なしで `POST /v1/calls` を叩くか、
 * 誤った発信元番号で**実際に電話が鳴る**。呼び出し側は null を「mock 経路」と読むので、
 * 半端な設定のテナントは従来どおり mock のまま＝外部送信が起こらない。
 *
 * ## `adapter-factory.ts` の `buildVonageConfig` と分けてある理由
 *
 * あちらは **Video API**（遠隔顔合わせ）用で `apiKey` / `apiSecret` を必須にする。
 * Voice の発信に必要なのは `applicationId` / `privateKey` / `fromNumber` で、
 * 必須項目が違う。共通化すると「Video 用の key が無いから電話も掛けられない」
 * （またはその逆）という、実態に無い結合ができる。
 *
 * **server-only**。`SecretValue.reveal()` を呼ぶので client から import しないこと。
 */
import { endpointAddress } from '@/domain/routing/endpoint';
import { asTenantId } from '@/domain/tenant/types';
import type { VoiceCallInitiator } from '@/domain/routing/voice-initiator';
import type { VoiceCallTerminator } from '@/domain/routing/voice-terminator';
import { createVonageVoiceTerminator } from '@/lib/call/vonage-voice-terminator';
import {
  createVonageVoiceInitiator,
  type VonageVoiceCredentials,
} from '@/lib/call/vonage-voice-initiator';
import { generateAppJwt } from '@/lib/call/vonage-jwt';
import {
  resolveProviderForTenant,
  type ResolvedProvider,
} from '@/lib/platform/provider-resolution';
import { getRoutingRepositories } from './store';

/** Vonage Voice API の基底 URL（Video の `video.api.vonage.com` とは別）。 */
const VONAGE_VOICE_API_BASE_URL = 'https://api.nexmo.com';

/** 真値として受ける表記。運用者が書き間違えても「有効になっていない」に倒す。 */
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * **新規発信**の停止スイッチ (#4 Inc D-2 項目 2)。既定は false（発信可）。
 *
 * 🔴 `PROVIDER_WEBHOOKS_DISABLED`（`./provider-webhook-switch.ts`）とは**別物**。
 * あちらは webhook ＝ **発信した後の進行**を止めるもので、**新しく電話が鳴るのは止まらない**。
 * 実発信を配線した以上、入口を止める手段が別に要る。
 *
 * 発信の入口はこのモジュール 1 つなので、ここを false に倒せば全経路が mock へ落ちる
 * （受付そのものは従来どおり完遂する ── 止めても来訪者を締め出さない）。
 *
 * env に置く理由は停止スイッチ共通: 止めたい状況（データ層異常・高負荷）でこそ
 * DynamoDB 由来の設定は読めない。**server-only**（`NEXT_PUBLIC_` を付けないこと）。
 */
export function voiceDialingDisabled(): boolean {
  const raw = process.env.VOICE_DIALING_DISABLED;
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * 解決済み vonage プロバイダから**発信用**資格情報を組み立てる。欠けていれば null。
 * 生値化（`reveal()`）はここでのみ行う。
 */
export function buildVoiceCredentials(resolved: ResolvedProvider): VonageVoiceCredentials | null {
  if (resolved.provider !== 'vonage') return null;

  const { applicationId, fromNumber } = resolved.settings;
  if (!applicationId || !fromNumber) return null;

  let bundle: { privateKey?: unknown };
  try {
    bundle = JSON.parse(resolved.secret.reveal()) as { privateKey?: unknown };
  } catch {
    // secret が JSON でない＝設定不備。例外にせず mock へ倒す（発信を止める側が安全）。
    return null;
  }
  const { privateKey } = bundle;
  if (typeof privateKey !== 'string' || privateKey.length === 0) return null;

  return {
    applicationId,
    // PEM を 1 行 secret に入れる際の \n エスケープを実改行へ戻す（adapter-factory と同じ扱い）。
    privateKeyPem: privateKey.replace(/\\n/g, '\n'),
    fromNumber,
  };
}

export type ResolveVoiceInitiatorDeps = {
  resolveProvider?: (tenantId: string) => Promise<ResolvedProvider>;
  signJwt?: (params: { applicationId: string; privateKeyPem: string }) => string;
  fetch?: typeof globalThis.fetch;
  /** `endpointId` → 接続先。既定は保存済み接続先リポジトリ。 */
  resolveEndpoint?: (tenantId: string, endpointId: string) => Promise<{ address?: string }>;
  apiBaseUrl?: string;
};

/** 保存済み接続先から E.164 を引く。**PSTN 以外は発信対象にしない**（SIP は別経路）。 */
async function defaultResolveEndpoint(
  tenantId: string,
  endpointId: string,
): Promise<{ address?: string }> {
  const endpoints = await getRoutingRepositories().endpoints.list(asTenantId(tenantId));
  const found = endpoints.find((e) => e.id === endpointId);
  if (!found || !found.enabled || found.channel !== 'pstn') return {};
  return { address: endpointAddress(found) };
}

/**
 * テナントの実 PSTN 発信者を解決する。**null は「実発信しない」**（mock 経路）。
 *
 * `webhookBaseUrl` は **CloudFront のドメイン**であること（`resolveWebhookBaseUrl`）。
 * Function URL を渡すと `x-origin-verify` が付かず全 webhook が 403 になる。
 */
export async function resolveVoiceInitiator(
  tenantId: string,
  webhookBaseUrl: string,
  deps: ResolveVoiceInitiatorDeps = {},
): Promise<VoiceCallInitiator | null> {
  // 停止スイッチは**資格情報の解決より前**。止めたい状況（誤発信・高負荷・調査中）では
  // secret すら読ませない。ここで null にすると全経路が mock へ倒れる＝外部送信が起きない。
  if (voiceDialingDisabled()) return null;

  const resolveProvider = deps.resolveProvider ?? resolveProviderForTenant;
  const resolved = await resolveProvider(tenantId);
  const credentials = buildVoiceCredentials(resolved);
  if (credentials === null) return null;

  const resolveEndpoint = deps.resolveEndpoint ?? defaultResolveEndpoint;

  return createVonageVoiceInitiator({
    resolveNumber: async (endpointId) => (await resolveEndpoint(tenantId, endpointId)).address,
    credentials: async () => credentials,
    signJwt: deps.signJwt ?? generateAppJwt,
    baseUrl: deps.apiBaseUrl ?? VONAGE_VOICE_API_BASE_URL,
    webhookBaseUrl,
    // 🔴 `globalThis` へ束縛する。裸の `globalThis.fetch` を渡すと、呼び出し側では
    // `deps.fetch(...)` ＝ deps オブジェクトを `this` として呼ぶことになり、`this` を
    // 検査する実装（ブラウザの `window.fetch` や一部 polyfill）で Illegal invocation になる。
    // **テストは必ず fetch を注入するので、この経路はテストでは一度も通らない。**
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
  });
}

/**
 * テナントの**切断**境界を解決する。`null` は「切るべき実通話が無い」(#743)。
 *
 * 🔴 **`voiceDialingDisabled()` で止めない。** あのスイッチの doc が書いているとおり
 * **新規発信**の停止であって、切断は新規発信ではない。ここを止めると、スイッチを倒した
 * 瞬間に「鳴りっぱなしの電話を切る手段」まで失う ── 止めたい状況（誤発信・高負荷）で
 * いちばん切りたいのに切れない、という逆を踏む。切断は外部への影響を**減らす**方向の操作。
 *
 * 資格情報の解決は発信と同じ経路を使う（`buildVoiceCredentials`）。切断に `fromNumber` は
 * 要らないが、**切る相手は必ず自分が撃った通話**なのでその時点で揃っている。
 */
export async function resolveVoiceTerminator(
  tenantId: string,
  deps: ResolveVoiceInitiatorDeps = {},
): Promise<VoiceCallTerminator | null> {
  const resolveProvider = deps.resolveProvider ?? resolveProviderForTenant;
  const credentials = buildVoiceCredentials(await resolveProvider(tenantId));
  if (credentials === null) return null;

  return createVonageVoiceTerminator({
    credentials: async () => credentials,
    signJwt: deps.signJwt ?? generateAppJwt,
    baseUrl: deps.apiBaseUrl ?? VONAGE_VOICE_API_BASE_URL,
    // `globalThis` へ束縛する理由は `resolveVoiceInitiator` と同じ。
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
  });
}
