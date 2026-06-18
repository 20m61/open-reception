/**
 * 管理ロールと認可マッピング (issue #70)。
 * Microsoft Entra ID の App Role（roles claim）を open-reception の管理ロールへ写像する。
 * ロール判定は純関数として切り出し、middleware / route から再利用・単体テストする。
 */
export const ADMIN_ROLES = ['Admin', 'SiteManager', 'Viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Entra App Role 文字列 → 管理ロール。
 * 既定の命名（OpenReception.Admin など）と短縮名の双方を受け付ける。
 */
const APP_ROLE_TO_ADMIN_ROLE: Record<string, AdminRole> = {
  'OpenReception.Admin': 'Admin',
  'OpenReception.SiteManager': 'SiteManager',
  'OpenReception.Viewer': 'Viewer',
  Admin: 'Admin',
  SiteManager: 'SiteManager',
  Viewer: 'Viewer',
};

/** ロールの権限の強さ（大きいほど強い）。最小権限の比較に使う。 */
const ROLE_RANK: Record<AdminRole, number> = { Viewer: 1, SiteManager: 2, Admin: 3 };

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * roles claim（App Role 文字列の配列）から最も強い管理ロールを決める。
 * 既知のロールが無い場合は null（＝アクセス拒否）。
 */
export function resolveAdminRole(rolesClaim: unknown): AdminRole | null {
  if (!Array.isArray(rolesClaim)) return null;
  let best: AdminRole | null = null;
  for (const raw of rolesClaim) {
    if (typeof raw !== 'string') continue;
    const mapped = APP_ROLE_TO_ADMIN_ROLE[raw];
    if (!mapped) continue;
    if (best === null || ROLE_RANK[mapped] > ROLE_RANK[best]) best = mapped;
  }
  return best;
}

/**
 * 設定文字列（カンマ区切りの許可ロール）を AdminRole 集合へ。
 * 空/未設定なら全ロール許可（ロール claim を持つ管理者を受け入れる）。
 */
export function parseAllowedRoles(raw: string | undefined): Set<AdminRole> {
  if (!raw || raw.trim() === '') return new Set(ADMIN_ROLES);
  const out = new Set<AdminRole>();
  for (const part of raw.split(',')) {
    const mapped = APP_ROLE_TO_ADMIN_ROLE[part.trim()];
    if (mapped) out.add(mapped);
  }
  return out.size > 0 ? out : new Set(ADMIN_ROLES);
}

/** 書き込み（作成/更新/失効/並び替え等）が許可されるロールか。Viewer は読み取り専用。 */
export function canWrite(role: AdminRole): boolean {
  return role === 'Admin' || role === 'SiteManager';
}
