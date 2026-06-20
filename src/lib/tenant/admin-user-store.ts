/**
 * AdminUser 永続化ストア (issue #80, increment 2 — キーストン)。
 *
 * 実 actor 解決(#117) で残った「全管理ユーザーが env 既定テナントに集約される」状態を
 * 解消するための実データ層。Entra ログイン時に当該ユーザーの**実 assignments**（テナント/
 * サイト境界付き RoleAssignment）をここから解決し、真のテナント分離へ近づける。
 *
 * 永続化は既存業務データと同じ流儀で getBackend()（DATA_BACKEND=memory|dynamodb）の
 * Collection に委譲する（docs/persistence-design.md）。コレクション名は 'admin_user'。
 *
 * 解決キー:
 *   - findBySubject(subject): Entra 安定主体（oid/sub）。認証連携の正キー。
 *   - findByEmail(email):     subject 未登録時の補助（大文字小文字無視）。
 * いずれも list() 走査で実装する。AdminUser は小規模（管理者のみ）であり、既存の
 * LogStore.findBy のパーティション走査フォールバックと同じ扱い。GSI 化は将来増分。
 *
 * テナント境界の強制（他テナントのデータを返さない）は本層では行わず、解決した
 * AdminUser.assignments を src/domain/tenant/authorization.ts の純関数で判定する責務分離。
 *
 * PII 最小化: email は表示・補助解決用途のみ。不要な PII は保存しない（#80 厳守事項）。
 */
import {
  asAdminUserId,
  type AdminUser,
  type AdminUserId,
} from '@/domain/tenant/types';
import { getBackend } from '@/lib/data';
import type { AdminUserRepository } from './repository';

const COLLECTION = 'admin_user';

/**
 * dev/CI 用の seed。単一テナント運用互換（docs/multitenant-design.md §移行・互換）に合わせ、
 * `internal` テナントの tenant_admin を 1 件だけ投入する。
 *
 * OPEN_RECEPTION_ADMIN_SEED_SUBJECT を設定すると、その Entra subject を seed ユーザーに
 * 紐づけ、開発時に当該アカウントでログインすると実 assignments で解決できる。
 * 未設定なら subject 無し（email 解決のみ）。本番（dynamodb）では seed は適用されない。
 */
function seedAdminUsers(): AdminUser[] {
  const subject = process.env.OPEN_RECEPTION_ADMIN_SEED_SUBJECT?.trim();
  const email = process.env.OPEN_RECEPTION_ADMIN_SEED_EMAIL?.trim() ?? 'admin@internal.local';
  const tenantId = process.env.OPEN_RECEPTION_DEFAULT_TENANT_ID ?? 'internal';
  return [
    {
      id: asAdminUserId('admin-seed'),
      ...(subject ? { entraSubject: subject } : {}),
      email,
      displayName: '社内管理者（seed）',
      assignments: [
        {
          role: 'tenant_admin',
          tenantId: tenantId as AdminUser['assignments'][number]['tenantId'],
          siteId: null,
          deviceId: null,
        },
      ],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
}

const adminUsers = () =>
  getBackend().collection<AdminUser>(COLLECTION, {
    seed: () => seedAdminUsers().map((u) => ({ ...u })),
  });

/** getBackend() に永続化する AdminUserRepository 実装。 */
export class DataBackedAdminUserRepository implements AdminUserRepository {
  async getAdminUser(id: AdminUserId): Promise<AdminUser | undefined> {
    return adminUsers().get(id);
  }

  async findBySubject(subject: string): Promise<AdminUser | undefined> {
    const needle = subject.trim();
    if (!needle) return undefined;
    const all = await adminUsers().list();
    return all.find((u) => u.entraSubject != null && u.entraSubject === needle);
  }

  async findByEmail(email: string): Promise<AdminUser | undefined> {
    const needle = email.trim().toLowerCase();
    if (!needle) return undefined;
    const all = await adminUsers().list();
    return all.find((u) => u.email.toLowerCase() === needle);
  }

  async putAdminUser(user: AdminUser): Promise<void> {
    await adminUsers().put(user);
  }
}

let repo: AdminUserRepository | undefined;

/** プロセス共有の AdminUser リポジトリ（getBackend に永続化）。 */
export function getAdminUserRepository(): AdminUserRepository {
  if (!repo) repo = new DataBackedAdminUserRepository();
  return repo;
}

/** テスト用: リポジトリのキャッシュと in-memory コレクションを破棄する。 */
export async function __resetAdminUserStore(): Promise<void> {
  await adminUsers().reset();
  repo = undefined;
}
