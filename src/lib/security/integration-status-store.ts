/**
 * 認証方式・外部連携・シークレット状態のストア (issue #93, increment 1)。
 *
 * セキュリティ最優先:
 *   - secret / private key / webhook secret の **値は永続化しない**。
 *     値の実在判定は環境変数（process.env）から行い、本ストアには
 *     presence / health / updatedAt / updatedBy のメタデータだけを保存する。
 *   - 既存 security-store（受付端末アクセス制御）とは別の singleton キーに分離し、
 *     既存挙動を一切変更しない。
 *
 * 永続化は data backend（memory / dynamodb）の singleton に委譲する
 * （docs/persistence-design.md）。
 */
import {
  applyConnectionResult,
  composeSecretStatus,
  deriveSecretPresence,
  isSecretKey,
  SECRET_KEYS,
  type ConnectionResult,
  type IntegrationStatus,
  type IntegrationStatusRecord,
  type SecretHealth,
  type SecretKey,
  type SecretStatus,
  type SecretStatusRecord,
} from '@/domain/security/integration-status';
import { getAdminAuthConfig, validateAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { getBackend } from '@/lib/data';
import { getVonagePresenceForTenant } from '@/lib/platform/integration-presence';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/** 永続化する状態の総体（値は含まない）。 */
type IntegrationStateDoc = {
  secrets: Partial<Record<SecretKey, SecretStatusRecord>>;
  integrations: Record<string, IntegrationStatusRecord>;
};

function defaults(): IntegrationStateDoc {
  return { secrets: {}, integrations: {} };
}

const store = () =>
  getBackend().singleton<IntegrationStateDoc>('integration_status', { default: defaults });

async function current(): Promise<IntegrationStateDoc> {
  const s = (await store().get()) ?? defaults();
  return { secrets: { ...s.secrets }, integrations: { ...s.integrations } };
}

/**
 * 環境変数から各シークレットの実在（presence）を検出する。**値は返さない**。
 * env 名はシークレット種別キーと一致させている。
 */
function detectSecretPresence(
  env: Record<string, string | undefined>,
): Record<SecretKey, ReturnType<typeof deriveSecretPresence>> {
  const out = {} as Record<SecretKey, ReturnType<typeof deriveSecretPresence>>;
  for (const key of SECRET_KEYS) {
    out[key] = deriveSecretPresence(env[key]);
  }
  return out;
}

/** UI 向けの全シークレット状態を返す（値は含まない）。 */
export async function listSecretStatuses(
  env: Record<string, string | undefined> = process.env,
): Promise<SecretStatus[]> {
  const doc = await current();
  const presence = detectSecretPresence(env);
  return SECRET_KEYS.map((key) => composeSecretStatus(key, presence[key], doc.secrets[key]));
}

/**
 * シークレットの状態メタデータを更新する。**値は受け取らない／保存しない**。
 * 「更新した」という事実（updatedAt/updatedBy）と health のみを記録する。
 * 値の実在は引き続き env 検出が正。
 */
export async function markSecretUpdated(
  key: SecretKey,
  updatedBy: string,
  health: SecretHealth = 'ok',
  now: () => Date = () => new Date(),
): Promise<SecretStatus> {
  if (!isSecretKey(key)) throw new Error('unknown secret key');
  const doc = await current();
  doc.secrets[key] = {
    presence: 'configured',
    health,
    updatedAt: now().toISOString(),
    updatedBy,
  };
  await store().put(doc);
  const presence = detectSecretPresence(process.env);
  return composeSecretStatus(key, presence[key], doc.secrets[key]);
}

/**
 * シークレットの状態を「クリア（要再設定）」としてマークする。**値には触れない**。
 * 実際の env / Secrets Manager からの削除は運用側の責務（本ストアは状態のみ）。
 */
export async function markSecretCleared(
  key: SecretKey,
  updatedBy: string,
  now: () => Date = () => new Date(),
): Promise<SecretStatus> {
  if (!isSecretKey(key)) throw new Error('unknown secret key');
  const doc = await current();
  doc.secrets[key] = {
    presence: 'missing',
    health: 'needs_rotation',
    updatedAt: now().toISOString(),
    updatedBy,
  };
  await store().put(doc);
  const presence = detectSecretPresence(process.env);
  // env にまだ値が残っていても、状態としては「要再設定」を表示する。
  return composeSecretStatus(key, presence[key], doc.secrets[key]);
}

/** 既知の外部連携の定義（inc1 は Vonage のみ。次増分で OAuth provider 等を追加）。 */
const INTEGRATIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'vonage', label: 'Vonage（通話）' },
];

/** presence（configured/enabled）の供給形。secret 値は含めない（状態のみ）。 */
export type IntegrationPresenceInput = { configured: boolean; enabled: boolean };
const UNCONFIGURED: IntegrationPresenceInput = { configured: false, enabled: false };

/**
 * UI 向けの全連携状態を返す（機密値は含まない）。
 *
 * Vonage の configured/enabled はテナント設定 presence（`getVonagePresenceForTenant`）由来。
 * 呼び出し側が対象テナントの presence を渡す（platform=選択中テナント / admin=既定テナント）。
 * 省略時は**既定テナント**の presence を解決する（単一テナント運用・横断 read の後方互換）。
 * `VONAGE_*` env は読まない（#405 Inc3 で撤去）。
 */
export async function listIntegrationStatuses(
  vonagePresence?: IntegrationPresenceInput,
): Promise<IntegrationStatus[]> {
  const presence = vonagePresence ?? (await getVonagePresenceForTenant(defaultTenantIdFrom()));
  const doc = await current();
  return INTEGRATIONS.map((def) => {
    const rec = doc.integrations[def.id];
    const p = def.id === 'vonage' ? presence : UNCONFIGURED;
    return {
      id: def.id,
      label: def.label,
      configured: p.configured,
      enabled: p.enabled,
      lastResult: rec?.lastResult ?? 'untested',
      lastSuccessAt: rec?.lastSuccessAt,
      lastFailureAt: rec?.lastFailureAt,
      lastErrorSummary: rec?.lastErrorSummary,
    };
  });
}

export function isKnownIntegration(id: string): boolean {
  return INTEGRATIONS.some((d) => d.id === id);
}

/**
 * 接続テスト結果を記録する（純関数 applyConnectionResult に委譲）。
 * errorSummary は機密を含めない短文である前提。
 */
export async function recordConnectionResult(
  id: string,
  result: 'success' | 'failure',
  errorSummary?: string,
  now: () => Date = () => new Date(),
): Promise<ConnectionResult> {
  const doc = await current();
  doc.integrations[id] = applyConnectionResult(
    doc.integrations[id],
    result,
    now().toISOString(),
    errorSummary,
  );
  await store().put(doc);
  return doc.integrations[id].lastResult;
}

/** 管理画面ログイン方式の状態を返す（Client Secret 等は含まない）。 */
export function listAuthMethodStatuses(
  env: Record<string, string | undefined> = process.env,
): { id: string; label: string; enabled: boolean; issues: string[] }[] {
  const cfg = getAdminAuthConfig(env);
  const check = validateAdminAuthConfig(cfg, env.NODE_ENV);
  return [
    {
      id: 'password',
      label: '共有パスワードログイン',
      enabled: cfg.provider === 'none',
      issues: cfg.provider === 'none' && !cfg.required ? ['認証が無効化されています'] : [],
    },
    {
      id: 'cognito',
      label: 'Cognito 標準ログイン',
      enabled: cfg.provider === 'cognito',
      issues: [],
    },
    {
      id: 'entra',
      label: 'Microsoft Entra ID ログイン',
      enabled: cfg.provider === 'entra',
      // 機密値は出さず、設定エラーの要約のみ。
      issues: cfg.provider === 'entra' ? check.errors : [],
    },
  ];
}

/** テスト用: 既定へ戻す。 */
export async function __resetIntegrationStatus(): Promise<void> {
  await store().reset();
}
