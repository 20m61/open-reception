import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { EnvConfig } from '../config/environments';

/**
 * OpenNext server Lambda に developer コスト画面用の Cost Explorer read 権限を付与する (#377)。
 *
 * Cost Explorer は resource-level permission に対応しないため Resource は `*`。Action は
 * 実績と予測に必要な 2 操作だけへ限定する。Project / Environment はサーバー環境変数で固定し、
 * クライアントが任意アカウント・任意タグキーを問い合わせられないようアプリ側でも制約する。
 */
export function configureCostExplorerAccess(
  serverFn: lambda.Function,
  config: EnvConfig,
): void {
  serverFn.addEnvironment('AWS_COST_EXPLORER_ENABLED', 'true');
  serverFn.addEnvironment('AWS_COST_PROJECT_TAG_VALUE', config.tags.Project);
  serverFn.addEnvironment('AWS_COST_ENVIRONMENT_TAG_VALUE', config.tags.Environment);
  serverFn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast'],
      resources: ['*'],
    }),
  );
}
