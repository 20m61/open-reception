/**
 * 環境別設定 (docs/infrastructure-design.md §4 と整合)。
 *
 * 設定値はコードで型付けし、付け忘れ・誤設定を型で防ぐ。
 * prod はログ保持・キャパシティを厳格化、dev は緩めにする。
 */
export type EnvironmentName = 'dev' | 'staging' | 'prod';

export interface WebConfig {
  /** server Lambda のメモリ (MB)。 */
  serverMemoryMb: number;
  /** server Lambda のタイムアウト (秒)。 */
  serverTimeoutSec: number;
  /** image optimization Lambda のメモリ (MB)。 */
  imageMemoryMb: number;
  /** CloudWatch Logs 保持日数。 */
  logRetentionDays: number;
  /** warmer (定期ウォームアップ) を有効化するか。低頻度環境では無効でよい。 */
  enableWarmer: boolean;
}

export interface EnvConfig {
  environment: EnvironmentName;
  /** リソース名 prefix。 */
  prefix: string;
  web: WebConfig;
  /** コスト管理タグ (docs/cost-management-tags.md)。 */
  tags: {
    Project: string;
    Environment: EnvironmentName;
    Owner: string;
    ManagedBy: string;
  };
}

const PROJECT = 'open-reception';
const OWNER = 'open-reception-team';

const BASE_TAGS = {
  Project: PROJECT,
  Owner: OWNER,
  ManagedBy: 'cdk',
} as const;

export const ENVIRONMENTS: Record<EnvironmentName, EnvConfig> = {
  dev: {
    environment: 'dev',
    prefix: `${PROJECT}-dev`,
    web: {
      serverMemoryMb: 1024,
      serverTimeoutSec: 30,
      imageMemoryMb: 1536,
      logRetentionDays: 14,
      enableWarmer: false,
    },
    tags: { ...BASE_TAGS, Environment: 'dev' },
  },
  staging: {
    environment: 'staging',
    prefix: `${PROJECT}-staging`,
    web: {
      serverMemoryMb: 1024,
      serverTimeoutSec: 30,
      imageMemoryMb: 1536,
      logRetentionDays: 30,
      enableWarmer: false,
    },
    tags: { ...BASE_TAGS, Environment: 'staging' },
  },
  prod: {
    environment: 'prod',
    prefix: `${PROJECT}-prod`,
    web: {
      serverMemoryMb: 2048,
      serverTimeoutSec: 30,
      imageMemoryMb: 2048,
      logRetentionDays: 90,
      enableWarmer: true,
    },
    tags: { ...BASE_TAGS, Environment: 'prod' },
  },
};

/** CDK context (`-c env=prod`) から環境設定を解決する。既定は dev。 */
export function resolveEnv(name: string | undefined): EnvConfig {
  const key = (name ?? 'dev') as EnvironmentName;
  const config = ENVIRONMENTS[key];
  if (!config) {
    throw new Error(
      `Unknown environment "${name}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`,
    );
  }
  return config;
}
