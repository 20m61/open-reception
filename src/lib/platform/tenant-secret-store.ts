/**
 * テナント別 secret ストアのプロセス共有ファクトリ (issue #405 Inc1)。
 *
 * **server-only（client から import 不可）**: secret 値を扱うため 'use client' から import しない
 * （`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
 *
 * Inc1 は in-memory mock のみ。Inc2 で Secrets Manager 実装（`tenants/<tenantId>/<provider>` を
 * Secrets Manager の名前空間へ写像）+ CDK を追加し、本ファクトリの選択を env で切り替える。
 */
import { InMemoryTenantSecretStore, type TenantSecretStore } from '@/domain/provider-config/secret';

let store: TenantSecretStore | undefined;

/** プロセス共有の secret ストア（Inc1 は in-memory）。 */
export function getTenantSecretStore(): TenantSecretStore {
  if (!store) store = new InMemoryTenantSecretStore();
  return store;
}

/** テスト用に初期化する（in-memory のみ実効）。 */
export function __resetTenantSecretStore(): void {
  store = undefined;
}
