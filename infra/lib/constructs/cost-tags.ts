import { Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { EnvConfig } from '../config/environments';

/**
 * コスト管理タグの一括付与 (docs/cost-management-tags.md, infrastructure-design.md §9)。
 *
 * 必須タグ (`Project`/`Environment`/`Component`/`Owner`/`ManagedBy`) を
 * scope 配下の全リソースへ付与する。Component は Stack 単位で渡す。
 */
export function applyCostTags(scope: IConstruct, env: EnvConfig, component: string): void {
  const tags = Tags.of(scope);
  tags.add('Project', env.tags.Project);
  tags.add('Environment', env.tags.Environment);
  tags.add('Component', component);
  tags.add('Owner', env.tags.Owner);
  tags.add('ManagedBy', env.tags.ManagedBy);
}
