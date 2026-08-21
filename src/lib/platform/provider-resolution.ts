/**
 * テナント別プロバイダの実行時解決 (issue #405 Inc3)。
 *
 * **server-only（client から import 不可）**: secret 値（`SecretValue`）を扱うため 'use client' から
 * import してはならない（`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
 *
 * 役割:
 *   受付/通知/通話の各生成点は、資格情報を **グローバル `VONAGE_*` env から読まず**、本層で
 *   テナント設定（`TenantProviderConfig` + `TenantSecretStore`）から解決する（Inc3 で env 経路を撤去）。
 *
 * 解決順（env フォールバックは存在しない）:
 *   1. テナント設定が provider='vonage' かつ enabled かつ secret set → **vonage**
 *      （非秘密設定 + secret を返す。secret は `SecretValue` の redacted wrapper のまま渡す）。
 *   2. それ以外（未設定 / provider='mock' / disabled / secret 未設定）→ **mock**（fail-closed）。
 *
 * セキュリティ:
 *   - 対象 `tenantId` は**呼び出し元の認可済みコンテキスト**から渡すこと（body/query 由来を使わない）。
 *     secret 参照名は `secretRef(tenantId, provider)`（`tenants/<tenantId>/<provider>`）で名前空間分離し、
 *     他テナントの secret を組み立てられない（Inc1 の `secret.ts` 契約）。
 *   - 本層は secret を**生値化しない**。`SecretValue` のまま返し、`reveal()` は接続情報を組む末端
 *     （adapter builder）でのみ呼ぶ。解決結果を serialize しても平文は出ない（`SecretValue.toJSON`）。
 */
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import { intendsRealDialingFrom } from '@/domain/provider-config/readiness';
import { secretRef, type SecretValue, type TenantSecretStore } from '@/domain/provider-config/secret';
import { getTenantProviderConfig } from './provider-config-store';
import { getTenantSecretStore } from './tenant-secret-store';

/** 解決済みプロバイダ（判別可能 union）。 */
export type ResolvedProvider =
  | { provider: 'mock' }
  | {
      provider: 'vonage';
      /** 非秘密の接続設定（値はそのまま渡してよい）。 */
      settings: {
        applicationId?: string;
        fromNumber?: string;
        timeoutMs?: number;
      };
      /** 資格情報 bundle。redacted wrapper のまま。生値は末端 builder が reveal() する。 */
      secret: SecretValue;
    };

/** テスト・呼び出し側で差し替え可能な依存（既定はプロセス共有のストア）。 */
export type ResolveProviderDeps = {
  loadConfig?: (tenantId: string) => Promise<TenantProviderConfig | null>;
  secretStore?: TenantSecretStore;
};

const MOCK: ResolvedProvider = { provider: 'mock' };

/**
 * テナントが**実発信を意図している**か（設定が vonage かつ有効）。
 *
 * 🔴 `resolveProviderForTenant` はこれを**答えられない**。あれは secret 欠如も設定不備も
 * すべて `mock` へ畳んでしまうので、返り値からは
 * 「mock でよい（dev / デモ）」と「vonage のつもりだったが繋がらない」の区別が付かない。
 *
 * その区別が要るのは、区別できないと**来訪者に嘘をつく**から。mock provider は bridge 系を
 * 無条件で `'answered'` にするので、資格情報が壊れているテナントでも来訪者には
 * 「担当者が応答しました」と出て受付が `completed` に到達する ——
 * **誰も呼ばれていないのに全員が受付完了する**（`VOICE_DIALING_DISABLED` について
 * `api/kiosk/receptions/[id]/call/route.ts` の N0 が塞いだのと同じ事故）。
 *
 * secret の**有無すら見ない**。見ると「意図」ではなく「今できるか」を答えることになり、
 * 呼び出し側が知りたい 2 つの事実が 1 つに畳まれて元に戻る。
 *
 * 🔴 **`fromNumber` を条件に含める。** vonage + enabled だけだと、**Video 受付だけで
 * 運用しているテナント**（遠隔顔合わせ。`src/lib/call/adapter-factory.ts` の
 * `VonageCallAdapter`）まで「PSTN を意図している」ことになる。あちらが要るのは
 * `applicationId` + `apiKey`/`apiSecret`/`privateKey` で、**発信元番号は要らない**
 * （`voice-dial.ts` が必須項目の違いを明記している）。含めないと、正常に動いている
 * Video 受付を全断させる。
 *
 * `fromNumber` は非秘密設定なので、これを見ても「secret を見ない」方針は崩れない。
 */
export async function intendsRealDialing(
  tenantId: string,
  deps: Pick<ResolveProviderDeps, 'loadConfig'> = {},
): Promise<boolean> {
  const loadConfig = deps.loadConfig ?? getTenantProviderConfig;
  // 🔴 **判定そのものはここに書かない。** 同じ問いに答える場所が管理画面（警告表示）にも
  // あり、片方だけ直すと「管理画面は未接続と出るのに受付は 503」というずれが復活する
  // （#763 で実際に起きていた形）。述語は `readiness.ts` の 1 つに集約する。
  return intendsRealDialingFrom(await loadConfig(tenantId));
}

/**
 * テナントの実行時プロバイダを解決する。テナント設定が無い/無効/secret 欠如なら Mock。
 * `tenantId` は認可済みコンテキスト由来のみ渡すこと（越境防止）。
 */
export async function resolveProviderForTenant(
  tenantId: string,
  deps: ResolveProviderDeps = {},
): Promise<ResolvedProvider> {
  const loadConfig = deps.loadConfig ?? getTenantProviderConfig;
  const config = await loadConfig(tenantId);
  if (!config || config.provider !== 'vonage' || !config.enabled) {
    return MOCK;
  }

  const secretStore = deps.secretStore ?? getTenantSecretStore();
  const secret = await secretStore.getSecret(secretRef(tenantId, 'vonage'));
  // enabled でも secret が無ければ実発信できない → Mock（fail-closed）。
  if (!secret) return MOCK;

  const settings: { applicationId?: string; fromNumber?: string; timeoutMs?: number } = {};
  if (config.applicationId !== undefined) settings.applicationId = config.applicationId;
  if (config.fromNumber !== undefined) settings.fromNumber = config.fromNumber;
  if (config.timeoutMs !== undefined) settings.timeoutMs = config.timeoutMs;

  return { provider: 'vonage', settings, secret };
}
