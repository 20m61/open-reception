/**
 * サイネージサービスの組み立て (issue #101, increment 1)。
 *
 * route から使う SignageService を 1 つ生成して共有する。永続化は getBackend()
 * （memory: dev/test/CI, dynamodb: 本番）に委譲する。監査は既存 appendAdminAudit を使い、
 * actor=admin・PII なしで 'signage.updated' を記録する。
 */
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { BackendSignageRepository } from './backend-repository';
import { SignageService } from './service';

let service: SignageService | undefined;

export function getSignageService(): SignageService {
  if (!service) {
    service = new SignageService({
      repo: new BackendSignageRepository(),
      appendAudit: appendAdminAudit,
    });
  }
  return service;
}

/** テスト用: サービスのキャッシュを破棄する（永続データ自体は getBackend 側でリセット）。 */
export function __resetSignageService(): void {
  service = undefined;
}
