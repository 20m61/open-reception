import { Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { EnvConfig } from '../config/environments';
import { CostTagComponent } from '../config/cost-components';

/**
 * コスト管理タグの一括付与 (docs/cost-management-tags.md, infrastructure-design.md §9)。
 *
 * 必須タグ (`Project`/`Environment`/`Component`/`Owner`/`ManagedBy`) を
 * scope 配下の全リソースへ付与する。Component は Stack 単位で渡す
 * （値は `../config/cost-components.ts` の `COST_TAG_COMPONENTS` を参照する）。
 */
export function applyCostTags(scope: IConstruct, env: EnvConfig, component: CostTagComponent): void {
  const tags = Tags.of(scope);
  tags.add('Project', env.tags.Project);
  tags.add('Environment', env.tags.Environment);
  tags.add('Component', component);
  tags.add('Owner', env.tags.Owner);
  tags.add('ManagedBy', env.tags.ManagedBy);
}

/**
 * 既存 Stack の Component タグを、より具体的な値へ上書きする (#379)。
 *
 * `applyCostTags` が付与する既定タグ（`priority` 省略 = 標準優先度）に対し、
 * `priority: 200`（高優先度 = 後勝ち）で明示上書きする。監視専用 Stack を親 Stack と
 * 同じ Component のままにすると Cost Explorer で監視コストが本体コストへ混入するため、
 * `bin/open-reception.ts` から Stack 構築の直後に呼ぶ。
 */
export function overrideComponentTag(scope: IConstruct, component: CostTagComponent): void {
  Tags.of(scope).add('Component', component, { priority: 200 });
}
