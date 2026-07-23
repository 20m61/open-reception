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

export interface DataConfig {
  /** DynamoDB の Point-in-Time Recovery を有効化するか。 */
  pointInTimeRecovery: boolean;
  /** 誤削除防止（DeletionProtection）を有効化するか。 */
  removalProtection: boolean;
}

/** 管理画面認証プロバイダ (issue #238)。デプロイ環境の既定は cognito。 */
export type AdminAuthProviderName = 'none' | 'cognito' | 'entra';

export interface AuthConfig {
  /**
   * 管理ログインの認証プロバイダ。**デプロイ環境の既定は `cognito`**（埋め込み SRP）。
   * `cognito` のとき WebStack が User Pool + App Client を作成し COGNITO_* / ADMIN_AUTH_PROVIDER を
   * server Lambda に注入する。ローカル/CI/e2e は CDK を通らないため未設定＝`none`（パスワード）。
   */
  adminProvider: AdminAuthProviderName;
}

/** 営業時間ポリシー (issue #366 Phase 0 ADR-002/0003)。初期値は固定時刻、DynamoDB 連携は後続 increment。 */
export interface RealtimeScheduleConfig {
  /** Asia/Tokyo 固定（DST 無し、offset +9h 決め打ち）。 */
  timezone: 'Asia/Tokyo';
  /** 起動時刻（JST, 0-23）。 */
  startHour: number;
  /** 停止時刻（JST, 0-23、startHour より大きい前提。日付をまたぐ営業時間は現状未対応）。 */
  stopHour: number;
  /** 停止前にセッション拒否へ切り替えるまでの猶予（分）。drain 自体はアプリ層 (#366 後続) が担う。 */
  drainBeforeMinutes: number;
  /** drain が完了しない場合に許容する最大延長（分）。 */
  maxExtensionMinutes: number;
}

/**
 * リアルタイム会話 EC2 基盤の環境別設定 (issue #366 Phase 0 ADR, `docs/adr/0003-*.md`)。
 *
 * `enabled: false` が既定。本プロジェクト初の実質的固定費（現行 AWS 実績は月 $0.0005）のため、
 * ユーザー承認を得て `true` に切り替えるまで `RealtimeRuntimeStack` は `bin/open-reception.ts` から
 * synth 対象に含まれない（`cdk synth` はしても deploy はしないという安全側の既定）。
 */
export interface RealtimeRuntimeConfig {
  /** false の間は Stack を app へ追加しない（deploy 事故防止の既定オフ）。 */
  enabled: boolean;
  /** EC2 instance type 識別子 (ADR-006: 負荷試験で確定するまでの初期値は t4g.small)。 */
  instanceType: string;
  /** ルート EBS(gp3) サイズ (GiB)。 */
  rootVolumeSizeGb: number;
  /** 営業時間スケジュール。 */
  schedule: RealtimeScheduleConfig;
  /** Reconciler Lambda の CloudWatch Logs 保持日数。 */
  logRetentionDays: number;
  /** 月額 Budget 上限 (USD)。ADR-0003 の見積を上回る監視閾値。 */
  monthlyBudgetUsd: number;
  /** Budget 超過通知先メール（空文字なら SNS/Email 購読を作らない）。 */
  budgetAlarmEmail: string;
}

export interface EnvConfig {
  environment: EnvironmentName;
  /** リソース名 prefix。 */
  prefix: string;
  web: WebConfig;
  notification: NotificationConfig;
  data: DataConfig;
  /** 管理画面認証 (issue #238)。 */
  auth: AuthConfig;
  /** リアルタイム会話 EC2 基盤 (issue #366)。 */
  realtime: RealtimeRuntimeConfig;
  /** コスト管理タグ (docs/cost-management-tags.md)。 */
  tags: {
    Project: string;
    Environment: EnvironmentName;
    Owner: string;
    ManagedBy: string;
  };
}

/** 全環境共通の初期スケジュール (issue #366 本文の初期ポリシー)。 */
const DEFAULT_REALTIME_SCHEDULE: RealtimeScheduleConfig = {
  timezone: 'Asia/Tokyo',
  startHour: 8,
  stopHour: 23,
  drainBeforeMinutes: 10,
  maxExtensionMinutes: 10,
};

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
    data: { pointInTimeRecovery: false, removalProtection: false },
    auth: { adminProvider: 'cognito' },
    // issue #366 Phase 0 ADR (docs/adr/0003-*.md) の見積 (t4g.small, 15h/日) は
    // 約 $14/月。バッファを見て Budget 上限は $20 に設定。enabled は承認まで false。
    realtime: {
      enabled: false,
      instanceType: 't4g.small',
      rootVolumeSizeGb: 20,
      schedule: DEFAULT_REALTIME_SCHEDULE,
      logRetentionDays: 7,
      monthlyBudgetUsd: 20,
      budgetAlarmEmail: '',
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
    data: { pointInTimeRecovery: true, removalProtection: false },
    auth: { adminProvider: 'cognito' },
    realtime: {
      enabled: false,
      instanceType: 't4g.small',
      rootVolumeSizeGb: 20,
      schedule: DEFAULT_REALTIME_SCHEDULE,
      logRetentionDays: 14,
      monthlyBudgetUsd: 25,
      budgetAlarmEmail: '',
    },
    tags: { ...BASE_TAGS, Environment: 'staging' },
  },
  prod: {
    environment: 'prod',
    prefix: `${PROJECT}-prod`,
    web: {
      // dev 実測 (issue #308): Max Memory Used ~161MB / 1024MB 設定、p50 46ms・TTFB 50-90ms。
      // 2048 は実測に基づかない初期値だったため 1024 に是正（メモリ×時間課金が半減）。
      // 実トラフィック開始後は WebMonitoring ダッシュボード (#299) で再評価する。
      serverMemoryMb: 1024,
      serverTimeoutSec: 30,
      // image は直近 7 日で呼び出しゼロ（実測なし・課金ゼロ）のため据え置き (issue #308)。
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
    data: { pointInTimeRecovery: true, removalProtection: true },
    auth: { adminProvider: 'cognito' },
    // prod は t4g.medium への切替（ADR-006 負荷試験後）を見込みバッファを厚めに取る。
    realtime: {
      enabled: false,
      instanceType: 't4g.small',
      rootVolumeSizeGb: 20,
      schedule: DEFAULT_REALTIME_SCHEDULE,
      logRetentionDays: 30,
      monthlyBudgetUsd: 30,
      budgetAlarmEmail: '',
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
