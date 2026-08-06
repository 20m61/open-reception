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
 * 🔴 **register() は middleware より後に走る。middleware が読む値をここで注入してはいけない** (#612)。
 *
 * register() が起動するのは Next サーバが最初のリクエストを処理するとき
 * （`base-server.js` の `handleRequest` → `prepare()` → `runInstrumentationHookIfAvailable`）。
 * 一方 middleware(proxy) は **OpenNext の routing 層から、それより前に**呼ばれる
 * （`@opennextjs/aws` は instrumentation を一切参照しない）。しかも middleware が応答を返すと
 * routing 層はその場で返し、Next サーバへ到達しない ＝ register() が走らない。
 *
 * したがってここで解決してよいのは **SSR / Route Handler だけが読む値**（`getAdminSecret()` 等）。
 * middleware が読む値（`ORIGIN_VERIFY_SECRET`）は CDK が Lambda 環境変数として渡す。
 * 詳細は `infra/lib/stacks/web-stack.ts` の origin-verify 節。
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
  } catch {
    // **cause を連結しない (#612)。** V8 は JSON.parse 失敗時のメッセージに入力を埋め込む
    // （**20 文字以下なら全体**、超えると先頭 10 文字 + `...`）。短いシークレットは丸ごと出る。
    // シークレットを JSON ではなく生文字列で保存する設定ミスは起きやすく、そのとき
    // cause チェーンが console.error 経由で CloudWatch へシークレットの先頭を書き出す。
    // SDK エラー（上の catch）は値を含まないので cause を残してよい。
    throw new Error(
      `Secret ${secretId} is not valid JSON. Expected a flat object of string values.`,
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
