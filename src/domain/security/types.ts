/**
 * 受付端末アクセス制御の設定 (issue #23, #29)。
 */
export type SecuritySettings = {
  /** PIN による初回許可を必須にするか。 */
  pinRequired: boolean;
  /** 受付端末許可用 PIN。 */
  pin: string;
  /** 許可 IP リスト（空なら全許可）。 */
  ipAllowlist: string[];
  /** 緊急停止モード。true の間は全受付端末を停止する。 */
  emergencyStop: boolean;
};

/** 端末レジストリの有効状態と緊急停止から、実際に受付可能かを決める（純関数）。 */
export function effectiveKioskActive(registryActive: boolean, emergencyStop: boolean): boolean {
  return registryActive && !emergencyStop;
}

/** 受付端末のアクセス状態。 */
export type KioskAccessState = 'revoked' | 'authorize' | 'ready';

/**
 * 端末設定とセッション状態から受付端末のアクセス状態を決める（純関数）。
 * - 失効端末は revoked。
 * - PIN 必須かつ未認可なら authorize。
 * - それ以外は ready。
 */
export function resolveKioskAccess(input: {
  active: boolean;
  pinRequired: boolean;
  authorized: boolean;
}): KioskAccessState {
  if (!input.active) return 'revoked';
  if (input.pinRequired && !input.authorized) return 'authorize';
  return 'ready';
}

/** IP が許可リストに含まれるか（空リストは全許可）。 */
export function isIpAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(ip);
}
