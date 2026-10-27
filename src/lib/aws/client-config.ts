/**
 * AWS SDK クライアント設定の単一解決点（ADR 0010 / #1103）。
 *
 * ## なぜ 1 か所に集めるのか
 *
 * 従来は各モジュールが `new XxxClient({ region })` を個別に組み、endpoint は
 * SDK が `AWS_ENDPOINT_URL` を暗黙に拾うことに任せていた。これは動くが、
 *
 * - **guard を置く場所が無い**（「向いてよいか」を判定する地点が存在しない）
 * - region の既定値が 5 か所に散らばって重複する
 * - エミュレータを替えるときに触る場所が読めない
 *
 * という問題がある。ここを通せば、実行系の差は endpoint / region / credentials の
 * 解決だけに閉じ、アプリ側に `if (ministack)` の類は 1 つも要らない。
 *
 * ## 使い方
 *
 *     const client = new SecretsManagerClient(awsClientConfig());
 *     const client = new SSMClient(awsClientConfig(undefined, { region }));
 */
import { resolveAwsRuntimeConfig } from '@/domain/governance/aws-runtime';

export type AwsClientConfig = {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

/**
 * SDK クライアントへ渡す設定を組む。
 *
 * @param env    省略時は `process.env`。テストから注入するための口。
 * @param overrides 呼び出し側が明示する値（既存の `{ region }` 呼び出しを壊さないため）。
 */
export function awsClientConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: { region?: string },
): AwsClientConfig {
  // 解決と同時に安全判定が走る。危険なら例外で、設定は返らない。
  const resolved = resolveAwsRuntimeConfig(env);
  const config: AwsClientConfig = { region: overrides?.region ?? resolved.region };
  // 実 AWS では endpoint / credentials を**載せない**。role / SSO / profile など
  // SDK の既定解決をそのまま使う。
  if (resolved.endpoint !== undefined) config.endpoint = resolved.endpoint;
  if (resolved.credentials !== undefined) config.credentials = { ...resolved.credentials };
  return config;
}
