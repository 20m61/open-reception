/**
 * Next.js instrumentation hook (#194)。
 *
 * server Lambda の起動時（プロセスにつき 1 回）に Secrets Manager から機密値を解決し
 * `process.env` に流し込む。これにより `getAdminSecret()` 等の **同期** getter は無改変で
 * 機密を runtime 取得できる（Lambda 環境変数へ平文注入する従来方式の置き換え）。
 *
 * - `APP_SECRETS_ARN` 未設定なら no-op（従来の env 注入方式にフォールバック＝後方互換）。
 * - 既に `process.env` に存在するキーは上書きしない（明示注入を優先）。
 * - 取得失敗時は **throw**（fail-fast）。本番で機密未解決のまま dev 既定値で稼働するのを防ぐ。
 *
 * register() は Next.js が SSR / Route Handler / middleware を処理する前に await する。
 * 本アプリの middleware(proxy) は単一 server function に内包される（open-next.config.ts）ため、
 * 同一プロセスの process.env が満たされた状態で middleware も実行される。
 */
export async function register(): Promise<void> {
  const secretId = process.env.APP_SECRETS_ARN;
  if (!secretId) return;

  // Node ランタイムでのみ動作させる（middleware/edge では AWS SDK を読み込まない）。
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});

  let secretString: string | undefined;
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    secretString = res.SecretString;
  } catch (cause) {
    throw new Error(
      `Failed to load application secrets from Secrets Manager (APP_SECRETS_ARN=${secretId}). ` +
        'Aborting startup to avoid running with insecure defaults.',
      { cause },
    );
  }

  if (!secretString) {
    throw new Error(
      `Secret ${secretId} has no SecretString (binary secrets are not supported). ` +
        'Provide a JSON object of key/value secrets.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch (cause) {
    throw new Error(
      `Secret ${secretId} is not valid JSON. Expected a flat object of string values.`,
      { cause },
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Secret ${secretId} must be a JSON object of string key/values (got ${Array.isArray(parsed) ? 'array' : typeof parsed}).`,
    );
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    // 明示注入（Lambda env / ローカル .env）を優先し、既存キーは上書きしない。
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
