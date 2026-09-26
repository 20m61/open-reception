/**
 * 受付端末アクセス制御の設定 (issue #23, #29)。
 */
export type SecuritySettings = {
  /** PIN による初回許可を必須にするか。 */
  pinRequired: boolean;
  /**
   * 受付端末許可用 PIN の**資格情報**。
   *
   * 🔴 **平文とは限らない (#1021 AC3)。** 新しい書き込みは PBKDF2 記録で、
   * 旧レコードは平文である。解釈は `@/domain/security/pin` の 1 箇所に閉じてあるので、
   * **ここを直接比較しないこと**（`verifyPinCredential` を使う）。
   */
  pin: string;
  /**
   * 運用者が PIN を**決めた**か（任意。旧レコードには無い）。
   *
   * 🔴 保存形式からは判定できない（レビュー 1 周目 MAJOR 2）——
   * 既定値も含めてハッシュで保存するようにしたので、「ハッシュ＝運用者が決めた」は
   * 成り立たなくなった。無い場合は旧レコードとして「平文が組込み既定と違うか」で判定する。
   */
  pinSetByOperator?: boolean;
  /** 許可 IP リスト（空なら全許可）。 */
  ipAllowlist: string[];
  /** 緊急停止モード。true の間は全受付端末を停止する。 */
  emergencyStop: boolean;
  /**
   * 記録の版（任意。旧レコードには無く、0 として読む）(#1158)。
   * 書くたびに 1 つ進み、条件付き書き込みの比較に使う。**直接書かないこと**
   * （`updateSecuritySettings` だけが進める）。
   */
  rev?: number;
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
