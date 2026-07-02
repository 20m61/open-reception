/**
 * 受付端末レジストリのストア (issue #18)。端末登録・失効・設定取得を扱う。
 *
 * #274 ② で §9 標準（docs/persistence-design.md）へ統合: 永続化は KioskRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getKioskRepository）と互換 API（入力検証・config 導出のサービス層）を担う。
 * 既存呼び出し側（/api/kiosk/*, /api/admin/kiosks/*, device-fleet）の変更は不要。
 */
import type { Kiosk, KioskConfig } from '@/domain/kiosk/types';
import { DataBackedKioskRepository, type KioskRepository } from './repository';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const SEED: Kiosk[] = [
  { id: 'kiosk-dev', displayName: '受付端末1', location: '本社1Fエントランス', enabled: true },
];

let repository: KioskRepository | undefined;

/** プロセス共有の KioskRepository（§9.2 のファクトリ）。 */
export function getKioskRepository(): KioskRepository {
  if (!repository) {
    repository = new DataBackedKioskRepository(() => SEED.map((k) => ({ ...k })));
  }
  return repository;
}

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export async function listKiosks(): Promise<Kiosk[]> {
  // 端末レジストリは構造的に小さい（拠点あたり数台）。既定上限（500, #274）で十分。
  return getKioskRepository().listKiosks();
}

export async function getKiosk(id: string): Promise<Result<Kiosk>> {
  const found = await getKioskRepository().getKiosk(id);
  return found ? { ok: true, value: found } : err('not_found', 'kiosk not found');
}

export async function createKiosk(input: unknown): Promise<Result<Kiosk>> {
  if (typeof input !== 'object' || input === null) return err('invalid_input', 'body must be an object');
  const o = input as Record<string, unknown>;
  if (typeof o.displayName !== 'string' || o.displayName.trim() === '')
    return err('invalid_input', 'displayName is required');
  const kiosk: Kiosk = {
    id: `kiosk-${Math.random().toString(36).slice(2, 8)}`,
    displayName: o.displayName.trim(),
    location: typeof o.location === 'string' && o.location.trim() !== '' ? o.location.trim() : undefined,
    enabled: true,
  };
  await getKioskRepository().putKiosk(kiosk);
  return { ok: true, value: kiosk };
}

export async function setKioskEnabled(id: string, enabled: boolean): Promise<Result<Kiosk>> {
  const repo = getKioskRepository();
  const found = await repo.getKiosk(id);
  if (!found) return err('not_found', 'kiosk not found');
  found.enabled = enabled;
  await repo.putKiosk(found);
  return { ok: true, value: found };
}

/** 受付端末向けの設定を返す。未登録・失効端末は active=false。 */
export async function getKioskConfig(id: string): Promise<KioskConfig> {
  // 空 id（kioskId 未指定）は未登録端末として扱う。DynamoDB バックエンドは空文字の
  // キー属性（SK）を拒否し ValidationException→500 になるため、ストアを引く前に短絡する。
  if (!id) return { kioskId: id, active: false };
  const found = await getKioskRepository().getKiosk(id);
  if (!found || !found.enabled) {
    return { kioskId: id, active: false };
  }
  return { kioskId: found.id, displayName: found.displayName, active: true };
}

/** テスト用: ストアを seed 状態に戻す。 */
export async function __resetKiosks(): Promise<void> {
  await getKioskRepository().reset();
}
