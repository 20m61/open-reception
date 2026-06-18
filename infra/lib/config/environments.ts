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
}

export interface NotificationConfig {
  /** 通知 Lambda のメモリ (MB)。 */
  memoryMb: number;
  /** 通知 Lambda のタイムアウト (秒)。Vonage タイムアウトに余裕を持たせる。 */
  timeoutSec: number;
  /** CloudWatch Logs 保持日数。 */
  logRetentionDays: number;
  /** API Gateway スロットリング（rate=平均 req/s, burst=瞬間上限）。 */
  throttle: { rateLimit: number; burstLimit: number };
  /** 拠点設定を保持する SSM パラメータ prefix。 */
  siteConfigPrefix: string;
  /** Polly を実呼び出しするか（false なら mock 音声）。 */
  pollyEnabled: boolean;
  /** アラーム通知先メール（空なら SNS購読を作らない）。 */
  alarmEmail: string;
}

export interface EnvConfig {
  environment: EnvironmentName;
  /** リソース名 prefix。 */
  prefix: string;
  web: WebConfig;
  notification: NotificationConfig;
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
    },
    notification: {
      memoryMb: 256,
      timeoutSec: 15,
      logRetentionDays: 14,
      throttle: { rateLimit: 20, burstLimit: 40 },
      siteConfigPrefix: '/open-reception/dev/sites',
      pollyEnabled: false,
      alarmEmail: '',
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
    },
    notification: {
      memoryMb: 256,
      timeoutSec: 15,
      logRetentionDays: 30,
      throttle: { rateLimit: 50, burstLimit: 100 },
      siteConfigPrefix: '/open-reception/staging/sites',
      pollyEnabled: true,
      alarmEmail: '',
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
    },
    notification: {
      memoryMb: 512,
      timeoutSec: 20,
      logRetentionDays: 90,
      throttle: { rateLimit: 100, burstLimit: 200 },
      siteConfigPrefix: '/open-reception/prod/sites',
      pollyEnabled: true,
      alarmEmail: '',
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
