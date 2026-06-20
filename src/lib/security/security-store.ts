/**
 * セキュリティ設定のストア (issue #23, #29)。既定では PIN 不要（既存運用を壊さない）。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import type { SecuritySettings } from '@/domain/security/types';
import { getBackend } from '@/lib/data';

function defaults(): SecuritySettings {
  return {
    pinRequired: false,
    pin: process.env.KIOSK_PIN ?? '0000',
    ipAllowlist: [],
    emergencyStop: false,
  };
}

const security = () => getBackend().singleton<SecuritySettings>('security', { default: defaults });

async function current(): Promise<SecuritySettings> {
  const s = (await security().get()) ?? defaults();
  return { ...s, ipAllowlist: [...s.ipAllowlist] };
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  return current();
}

export async function updateSecuritySettings(patch: unknown): Promise<SecuritySettings> {
  const settings = await current();
  if (typeof patch === 'object' && patch !== null) {
    const o = patch as Record<string, unknown>;
    if (typeof o.pinRequired === 'boolean') settings.pinRequired = o.pinRequired;
    if (typeof o.pin === 'string' && o.pin.trim() !== '') settings.pin = o.pin.trim();
    if (Array.isArray(o.ipAllowlist)) {
      settings.ipAllowlist = o.ipAllowlist.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    }
    if (typeof o.emergencyStop === 'boolean') settings.emergencyStop = o.emergencyStop;
  }
  await security().put(settings);
  return { ...settings, ipAllowlist: [...settings.ipAllowlist] };
}

export async function verifyPin(pin: string): Promise<boolean> {
  const settings = await current();
  return !settings.pinRequired || pin === settings.pin;
}

/** テスト用: 既定へ戻す。 */
export async function __resetSecurity(): Promise<void> {
  await security().reset();
}
