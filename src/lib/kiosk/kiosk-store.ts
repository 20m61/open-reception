/**
 * 受付端末レジストリのストア (issue #18)。端末登録・失効・設定取得を扱う。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import type { Kiosk, KioskConfig } from '@/domain/kiosk/types';
import { getBackend } from '@/lib/data';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const SEED: Kiosk[] = [
  { id: 'kiosk-dev', displayName: '受付端末1', location: '本社1Fエントランス', enabled: true },
];

const kiosks = () =>
  getBackend().collection<Kiosk>('kiosk', { seed: () => SEED.map((k) => ({ ...k })) });

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export async function listKiosks(): Promise<Kiosk[]> {
  // 端末レジストリは構造的に小さい（拠点あたり数台）。既定上限（500, #274）で十分。
  return kiosks().list();
}

export async function getKiosk(id: string): Promise<Result<Kiosk>> {
  const found = await kiosks().get(id);
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
  await kiosks().put(kiosk);
  return { ok: true, value: kiosk };
}

export async function setKioskEnabled(id: string, enabled: boolean): Promise<Result<Kiosk>> {
  const found = await kiosks().get(id);
  if (!found) return err('not_found', 'kiosk not found');
  found.enabled = enabled;
  await kiosks().put(found);
  return { ok: true, value: found };
}

/** 受付端末向けの設定を返す。未登録・失効端末は active=false。 */
export async function getKioskConfig(id: string): Promise<KioskConfig> {
  // 空 id（kioskId 未指定）は未登録端末として扱う。DynamoDB バックエンドは空文字の
  // キー属性（SK）を拒否し ValidationException→500 になるため、ストアを引く前に短絡する。
  if (!id) return { kioskId: id, active: false };
  const found = await kiosks().get(id);
  if (!found || !found.enabled) {
    return { kioskId: id, active: false };
  }
  return { kioskId: found.id, displayName: found.displayName, active: true };
}

/** テスト用: ストアを seed 状態に戻す。 */
export async function __resetKiosks(): Promise<void> {
  await kiosks().reset();
}
