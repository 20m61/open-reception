/**
 * セキュリティ設定の in-memory ストア (issue #23, #29)。
 * 既定では PIN 不要（既存運用を壊さない）。本番では永続化層・暗号化を検討する。
 */
import type { SecuritySettings } from '@/domain/security/types';

const DEFAULTS: SecuritySettings = {
  pinRequired: false,
  pin: process.env.KIOSK_PIN ?? '0000',
  ipAllowlist: [],
};

let settings: SecuritySettings = { ...DEFAULTS, ipAllowlist: [...DEFAULTS.ipAllowlist] };

export function getSecuritySettings(): SecuritySettings {
  return { ...settings, ipAllowlist: [...settings.ipAllowlist] };
}

export function updateSecuritySettings(patch: unknown): SecuritySettings {
  if (typeof patch === 'object' && patch !== null) {
    const o = patch as Record<string, unknown>;
    if (typeof o.pinRequired === 'boolean') settings.pinRequired = o.pinRequired;
    if (typeof o.pin === 'string' && o.pin.trim() !== '') settings.pin = o.pin.trim();
    if (Array.isArray(o.ipAllowlist)) {
      settings.ipAllowlist = o.ipAllowlist.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    }
  }
  return getSecuritySettings();
}

export function verifyPin(pin: string): boolean {
  return !settings.pinRequired || pin === settings.pin;
}

/** テスト用: 既定へ戻す。 */
export function __resetSecurity(): void {
  settings = { ...DEFAULTS, ipAllowlist: [...DEFAULTS.ipAllowlist] };
}
