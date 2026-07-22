/**
 * CDK Stack が Cost Explorer 集計用に付与する Component タグ値の全集合 (#379)。
 *
 * Component は Environment（dev/staging/prod）単位ではなく **Stack 単位**の値なので
 * `EnvConfig.tags`（Project/Environment/Owner/ManagedBy）には含めない。代わりに値そのものを
 * ここへ一元管理し、
 *   - 各 Stack の `applyCostTags(this, config, COST_TAG_COMPONENTS.xxx)` 呼び出し（既定値）、
 *   - `bin/open-reception.ts` の `overrideComponentTag(stack, COST_TAG_COMPONENTS.xxx)` 呼び出し
 *     （監視系 Stack を分離集計するための優先度付き上書き）
 * の両方から同じ定数を参照させることで、infra 内でのマジックストリング二重管理を無くす。
 *
 * `src/domain/platform/aws-cost.ts` の `COST_COMPONENT_FILTERS`（コスト画面が受け付ける
 * allow-list）は、infra と別 npm パッケージ（別リポジトリ内フォルダ）のため直接 import
 * できない。値の一致は `test/cost-components.test.ts` が両ファイルを読み比べて固定する
 * （drift すれば regression テストが red になる）。新しい Stack / Component を足したら
 * 両方を更新すること。
 */
export const COST_TAG_COMPONENTS = {
  web: 'web',
  webMonitoring: 'web-monitoring',
  cloudFrontMonitoring: 'cloudfront-monitoring',
  notification: 'notification',
  monitoring: 'monitoring',
} as const;

export type CostTagComponent = (typeof COST_TAG_COMPONENTS)[keyof typeof COST_TAG_COMPONENTS];
