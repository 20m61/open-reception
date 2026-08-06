/**
 * テナントの Vonage signature secret を引く (issue #4 MVP 1)。
 *
 * signed webhook の検証鍵。`apiSecret`（REST 認証用）とは**別物**なので、資格情報 bundle の
 * 独立したキー `signatureSecret` に置く。混同すると webhook 検証が常に失敗する。
 *
 * 生値化は本関数（末端）でのみ行い、呼び出し側へは `string | undefined` で渡す。
 * 未設定・provider 不一致・bundle 不備はすべて `undefined`（＝検証不能）で、
 * `resolveVerifiedWebhook` が fail-closed に倒す。
 *
 * **server-only**（secret 値を扱う）。'use client' から import しないこと。
 */
import {
  resolveProviderForTenant,
  type ResolveProviderDeps,
} from '@/lib/platform/provider-resolution';

export async function resolveVonageSignatureSecret(
  tenantId: string,
  deps?: ResolveProviderDeps,
): Promise<string | undefined> {
  const resolved = await resolveProviderForTenant(tenantId, deps);
  if (resolved.provider !== 'vonage') return undefined;

  let bundle: { signatureSecret?: unknown };
  try {
    bundle = JSON.parse(resolved.secret.reveal()) as { signatureSecret?: unknown };
  } catch {
    // 生値化に失敗しても中身をログ・例外へ載せない（rules/pii-secret-minimization.md）。
    return undefined;
  }
  const secret = bundle.signatureSecret;
  return typeof secret === 'string' && secret !== '' ? secret : undefined;
}
