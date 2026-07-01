/**
 * 来訪予約ストア/サービスの組み立て (issue #97, increment 1)。
 *
 * route から使う ReservationService を 1 つ生成して共有する。本増分の永続化は
 * in-memory（dev/test/CI）。DynamoDB 実装と getBackend() への接続は次増分
 * （docs/visit-reservation-design.md §increment 計画）。
 *
 * 監査は既存の appendAdminAudit（src/lib/data-stores/reception-log-store.ts）を使い、
 * actor=admin・PII なしで記録する。
 */
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { MemoryReservationRepository } from './memory-repository';
import { ReservationService } from './service';

let service: ReservationService | undefined;

export function getReservationService(): ReservationService {
  if (!service) {
    service = new ReservationService({
      repo: new MemoryReservationRepository(),
      appendAudit: appendAdminAudit,
    });
  }
  return service;
}

/** テスト用: サービス（と in-memory データ）を破棄する。 */
export function __resetReservationService(): void {
  service = undefined;
}
