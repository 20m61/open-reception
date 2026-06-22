/**
 * 管理画面の情報設計 (IA) を 1 箇所に集約する (issue #85, increment 1)。
 *
 * 責務:
 *   - `/admin/*`    … テナント管理者・拠点担当者向けの日常運用ナビ。
 *   - `/platform/*` … 総合開発者・プラットフォーム運用者向けのテナント横断ナビ。
 *
 * ここで確定したルート名は #90（platform コンソール）・#82（admin コンソール）が参照する。
 * 実際の認可は API 側で行い、本モジュールは表示制御（どのロールに何を見せるか）に閉じる。
 * ルートと IA の根拠は docs/admin-frontend-design.md。
 */
import type { TenantRole } from '@/domain/tenant/types';

/** ナビの 1 項目。 */
export type NavItem = {
  /** 遷移先（App Router ルート）。 */
  href: string;
  /** サイドバー等に表示する日本語ラベル。 */
  label: string;
  /**
   * 表示を許可するロール。未指定はそのグループの既定ロールを継承。
   * 表示制御のみ。実認可は API 側で `role`/`tenantId`/`siteId` を検証する。
   */
  roles?: readonly TenantRole[];
  /** 危険操作・破壊的操作を含む導線か（DangerZone 隔離対象の目印）。 */
  danger?: boolean;
};

/** ナビの責務グループ。 */
export type NavGroup = {
  /** グループ識別子。 */
  id: string;
  /** グループ見出し。 */
  label: string;
  /** このグループ全体を見せる既定ロール。各 item.roles で上書き可能。 */
  roles: readonly TenantRole[];
  items: readonly NavItem[];
};

/** テナント側で何かしらの閲覧権を持つロール。 */
const TENANT_VIEWERS: readonly TenantRole[] = [
  'developer',
  'tenant_admin',
  'site_manager',
  'viewer',
];

/** テナント管理者以上（テナント設定の編集権が要る領域）。 */
const TENANT_ADMINS: readonly TenantRole[] = ['developer', 'tenant_admin'];

/** プラットフォーム運用者のみ。 */
const PLATFORM_OPERATORS: readonly TenantRole[] = ['developer'];

/**
 * `/admin/*` の IA。
 *
 * 既存ページ（receptions/kiosks/departments/staff/assets/motions/voice/security/audit）は
 * 互換のため現行ルートを維持しつつ、本 IA の各グループへ位置づける（非破壊）。
 * 新ルート名（sites/devices/call-routes/messages/auth/usage/costs/audit-logs）は
 * docs の対応表に従い段階的に寄せる。
 */
export const ADMIN_NAV: readonly NavGroup[] = [
  {
    id: 'overview',
    label: '概況',
    roles: TENANT_VIEWERS,
    items: [{ href: '/admin', label: 'ダッシュボード' }],
  },
  {
    id: 'operations',
    label: '日常運用',
    roles: TENANT_VIEWERS,
    items: [
      { href: '/admin/receptions', label: '受付履歴' },
      { href: '/admin/reservations', label: '来訪予約' },
      { href: '/admin/stay', label: '在館状況' },
      { href: '/admin/sites', label: '拠点' },
      { href: '/admin/kiosks', label: '受付端末' },
      { href: '/admin/devices', label: '受付端末（拠点別）' },
      { href: '/admin/call-routes', label: '呼び出しルート' },
      { href: '/admin/departments', label: '部署' },
      { href: '/admin/staff', label: '担当者' },
    ],
  },
  {
    id: 'experience',
    label: '受付体験',
    roles: TENANT_ADMINS,
    items: [
      { href: '/admin/reception-flows', label: '受付フロー' },
      { href: '/admin/staff-response', label: '担当者応答' },
      { href: '/admin/ai-guidance', label: 'AI案内' },
      { href: '/admin/signage', label: '待機サイネージ' },
      { href: '/admin/assets', label: 'アセット' },
      { href: '/admin/motions', label: 'モーション' },
      { href: '/admin/voice', label: '音声' },
      { href: '/admin/languages', label: '言語設定' },
    ],
  },
  {
    id: 'status',
    label: '利用状況',
    roles: TENANT_VIEWERS,
    items: [
      { href: '/admin/usage', label: '利用量' },
      { href: '/admin/costs', label: '予想コスト' },
    ],
  },
  {
    id: 'governance',
    label: 'ガバナンス',
    roles: TENANT_VIEWERS,
    items: [
      { href: '/admin/security', label: 'セキュリティ', roles: TENANT_ADMINS },
      { href: '/admin/auth', label: '認証方式', roles: TENANT_ADMINS },
      { href: '/admin/integrations', label: '外部連携', roles: TENANT_ADMINS },
      { href: '/admin/audit', label: '監査ログ' },
    ],
  },
] as const;

/**
 * `/platform/*` の IA（#90 が本実装する画面のルートを先行確定）。
 * 通常時は読み取り中心。tenants の有効/停止・メンテナンス等の破壊的操作は danger 扱い。
 */
export const PLATFORM_NAV: readonly NavGroup[] = [
  {
    id: 'platform-overview',
    label: '概況',
    roles: PLATFORM_OPERATORS,
    items: [{ href: '/platform', label: 'ダッシュボード' }],
  },
  {
    id: 'platform-tenancy',
    label: 'テナント運用',
    roles: PLATFORM_OPERATORS,
    items: [
      { href: '/platform/tenants', label: 'テナント', danger: true },
      { href: '/platform/feature-flags', label: '機能フラグ' },
      { href: '/platform/integrations', label: '外部連携' },
    ],
  },
  {
    id: 'platform-reliability',
    label: '信頼性',
    roles: PLATFORM_OPERATORS,
    items: [
      { href: '/platform/observability', label: '可観測性' },
      { href: '/platform/maintenance', label: 'メンテナンス', danger: true },
      { href: '/platform/audit-logs', label: '監査ログ' },
    ],
  },
] as const;

/** actor のロール集合がグループ/項目を閲覧できるかを判定（表示制御のみ）。 */
function isVisibleFor(allowed: readonly TenantRole[], roles: readonly TenantRole[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/**
 * 与えたロール集合に対して表示すべきナビ（グループ→項目）を絞り込む。
 * 項目側に roles 指定があればそれを優先し、なければグループの roles を継承する。
 * 表示項目が 0 のグループは除外する。
 */
export function visibleNav(
  nav: readonly NavGroup[],
  roles: readonly TenantRole[],
): NavGroup[] {
  const result: NavGroup[] = [];
  for (const group of nav) {
    if (!isVisibleFor(group.roles, roles)) continue;
    const items = group.items.filter((item) =>
      isVisibleFor(item.roles ?? group.roles, roles),
    );
    if (items.length === 0) continue;
    result.push({ ...group, items });
  }
  return result;
}

/**
 * 現在のパスに対して、ナビ項目がアクティブかを判定する。
 * ルート完全一致、または配下パス（`href` + `/`）の前方一致でアクティブとみなす。
 * ルートインデックス（'/admin' '/platform'）は完全一致のみ（配下で誤点灯させない）。
 */
export function isActivePath(itemHref: string, pathname: string): boolean {
  if (itemHref === pathname) return true;
  const isRootIndex = itemHref === '/admin' || itemHref === '/platform';
  if (isRootIndex) return false;
  return pathname.startsWith(`${itemHref}/`);
}
