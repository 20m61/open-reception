import { ORIGIN_VERIFY_SECRET_ENV } from '@/lib/security/origin-verify';

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
 *
 * `ORIGIN_VERIFY_SECRET_ARN` (#612) も同じ経路で解決する。CloudFront 経由検証のシークレットを
 * Lambda 環境変数に平文で載せないための runtime 取得で、キー欠落は throw（fail-fast）。
 * これを黙って握り潰すと proxy 側が「シークレット未設定」に見え、迂回が素通りする。
 */
export async function register(): Promise<void> {
  const appSecretsArn = process.env.APP_SECRETS_ARN;
  const originVerifyArn = process.env.ORIGIN_VERIFY_SECRET_ARN;
  if (!appSecretsArn && !originVerifyArn) return;

  // Node ランタイムでのみ動作させる（middleware/edge では AWS SDK を読み込まない）。
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});

  /** Secrets Manager の JSON シークレットを取得して展開する。失敗は全て throw（fail-fast）。 */
  const fetchSecretJson = async (secretId: string): Promise<Record<string, unknown>> => {
    let secretString: string | undefined;
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      secretString = res.SecretString;
    } catch (cause) {
      throw new Error(
        `Failed to load application secrets from Secrets Manager (${secretId}). ` +
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

    return parsed as Record<string, unknown>;
  };

  // 同一シークレットを両方の env が指す運用（1 つの JSON にまとめる）を想定し、取得を 1 回にまとめる。
  const cache = new Map<string, Record<string, unknown>>();
  const loadSecretJson = async (secretId: string): Promise<Record<string, unknown>> => {
    const hit = cache.get(secretId);
    if (hit) return hit;
    const parsed = await fetchSecretJson(secretId);
    cache.set(secretId, parsed);
    return parsed;
  };

  if (appSecretsArn) {
    const parsed = await loadSecretJson(appSecretsArn);
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') continue;
      // 明示注入（Lambda env / ローカル .env）を優先し、既存キーは上書きしない。
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  if (originVerifyArn) {
    const parsed = await loadSecretJson(originVerifyArn);
    const value = parsed[ORIGIN_VERIFY_SECRET_ENV];
    if (typeof value !== 'string' || value === '') {
      // エラーメッセージにシークレット値そのものを含めない（迂回の手がかりを残さない）。
      throw new Error(
        `Secret ${originVerifyArn} has no string "${ORIGIN_VERIFY_SECRET_ENV}" key. ` +
          'Aborting startup: CloudFront origin verification would otherwise be skipped.',
      );
    }
    if (process.env[ORIGIN_VERIFY_SECRET_ENV] === undefined) {
      process.env[ORIGIN_VERIFY_SECRET_ENV] = value;
    }
  }
}
