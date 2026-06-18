import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvironmentName } from './environments';

/**
 * 環境設定の logRetentionDays を CloudWatch Logs の RetentionDays へ写像する共通ヘルパ
 * （web-stack / notification-stack で重複していたマップを一元化）。
 */
const RETENTION: Record<number, logs.RetentionDays> = {
  14: logs.RetentionDays.TWO_WEEKS,
  30: logs.RetentionDays.ONE_MONTH,
  90: logs.RetentionDays.THREE_MONTHS,
};

export function toRetentionDays(days: number): logs.RetentionDays {
  return RETENTION[days] ?? logs.RetentionDays.ONE_MONTH;
}

/** prod は保持、それ以外は破棄。各 Stack で繰り返していた判定を共通化。 */
export function prodRemovalPolicy(env: EnvironmentName): RemovalPolicy {
  return env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}
