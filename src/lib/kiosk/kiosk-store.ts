/**
 * 受付端末レジストリの in-memory ストア (issue #18)。
 * 端末登録・失効・設定取得を扱う。本番では永続化層へ置換する。
 */
import type { Kiosk, KioskConfig } from '@/domain/kiosk/types';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const SEED: Kiosk[] = [
  { id: 'kiosk-dev', displayName: '受付端末1', location: '本社1Fエントランス', enabled: true },
];

let kiosks: Kiosk[] = SEED.map((k) => ({ ...k }));

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function listKiosks(): Kiosk[] {
  return [...kiosks];
}

export function getKiosk(id: string): Result<Kiosk> {
  const found = kiosks.find((k) => k.id === id);
  return found ? { ok: true, value: found } : err('not_found', 'kiosk not found');
}

export function createKiosk(input: unknown): Result<Kiosk> {
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
  kiosks.push(kiosk);
  return { ok: true, value: kiosk };
}

export function setKioskEnabled(id: string, enabled: boolean): Result<Kiosk> {
  const found = kiosks.find((k) => k.id === id);
  if (!found) return err('not_found', 'kiosk not found');
  found.enabled = enabled;
  return { ok: true, value: found };
}

/** 受付端末向けの設定を返す。未登録・失効端末は active=false。 */
export function getKioskConfig(id: string): KioskConfig {
  const found = kiosks.find((k) => k.id === id);
  if (!found || !found.enabled) {
    return { kioskId: id, active: false };
  }
  return { kioskId: found.id, displayName: found.displayName, active: true };
}

/** テスト用: ストアを seed 状態に戻す。 */
export function __resetKiosks(): void {
  kiosks = SEED.map((k) => ({ ...k }));
}
