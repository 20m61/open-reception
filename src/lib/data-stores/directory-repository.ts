/**
 * 部署・担当者ディレクトリのリポジトリ (issue #274 ④)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ。
 * 検索・並び替え・入力検証は domain の純関数と directory-store.ts（互換 API）に残し、
 * 本ファイルは永続化の境界のみを担う。route は directory-store の互換 API 経由で使い、
 * collection 名や走査の詳細を知らない。
 *
 * 部署別の境界クエリ（listByIndex）は現時点では採らない:
 *   - 規模: 部署は構造的に小さく（既定上限 500 で十分）、担当者も 1 拠点あたり高々
 *     数百人規模の想定（STAFF_LIST_LIMIT = 1000 の安全弁で足りる）。
 *   - 制約: §9.3 の indexedField は**不変フィールド限定**だが、担当者の departmentId は
 *     異動（updateStaff / CSV インポート）で変わる可変フィールドのため適さない。
 *   - 上限に近づく組織規模になったら、#284 の設計（GSI / 維持カウンタ）と合わせて
 *     部署別クエリへ移行する。
 */
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import { getBackend } from '@/lib/data';
import { tenantScopedStoreKey } from '@/domain/tenant/store-key';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import type { Collection } from '@/lib/data/backend';

export const DEPARTMENT_COLLECTION = 'department';
export const STAFF_COLLECTION = 'staff';

/**
 * 担当者一覧の上限（#274 inc1）。部署は構造的に小さい（既定上限で十分）が、担当者は組織規模で
 * 増え得るため明示する。超過分は list() が warn つきで切り詰める。これを超える組織規模では
 * 境界付きクエリへ移行する（冒頭コメント参照）。
 */
export const STAFF_LIST_LIMIT = 1000;

export interface DirectoryRepository {
  /** 部署の全件（無効含む）。並び替え・enabled フィルタは呼び出し側（互換 API）で行う。 */
  listDepartments(tenantId: string): Promise<Department[]>;
  getDepartment(tenantId: string, id: string): Promise<Department | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側の責務）。 */
  putDepartment(tenantId: string, dept: Department): Promise<void>;
  /** 担当者の全件（無効含む、STAFF_LIST_LIMIT 上限）。検索・フィルタは呼び出し側で行う。 */
  listStaff(tenantId: string): Promise<Staff[]>;
  getStaff(tenantId: string, id: string): Promise<Staff | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側の責務）。 */
  putStaff(tenantId: string, member: Staff): Promise<void>;
  /** テスト用: seed 状態へ戻す（memory backend のみ実効）。 */
  reset(tenantId: string): Promise<void>;
}

/**
 * getBackend() に永続化するディレクトリリポジトリ。
 * seed は memory backend のみ有効（dev/test/CI）。dynamodb では無視され実データを正とする。
 */
export class DataBackedDirectoryRepository implements DirectoryRepository {
  private readonly depts: (tenantId: string) => Collection<Department>;
  private readonly staff: (tenantId: string) => Collection<Staff>;

  constructor(seedDepartments?: () => Department[], seedStaff?: () => Staff[]) {
    // **テナント別キー** (#419 残増分)。既定テナントは従来キー据え置きなので移行不要。
    // collection は従来どおり**呼び出しごとに**解決する（寿命モデルを変えない）。
    this.depts = (tenantId: string) =>
      getBackend().collection<Department>(
        tenantScopedStoreKey(DEPARTMENT_COLLECTION, tenantId, defaultTenantIdFrom()),
        { seed: seedDepartments },
      );
    this.staff = (tenantId: string) =>
      getBackend().collection<Staff>(
        tenantScopedStoreKey(STAFF_COLLECTION, tenantId, defaultTenantIdFrom()),
        { seed: seedStaff },
      );
  }

  async listDepartments(tenantId: string): Promise<Department[]> {
    return this.depts(tenantId).list();
  }

  async getDepartment(tenantId: string, id: string): Promise<Department | undefined> {
    return this.depts(tenantId).get(id);
  }

  async putDepartment(tenantId: string, dept: Department): Promise<void> {
    await this.depts(tenantId).put(dept);
  }

  async listStaff(tenantId: string): Promise<Staff[]> {
    return this.staff(tenantId).list({ limit: STAFF_LIST_LIMIT });
  }

  async getStaff(tenantId: string, id: string): Promise<Staff | undefined> {
    return this.staff(tenantId).get(id);
  }

  async putStaff(tenantId: string, member: Staff): Promise<void> {
    await this.staff(tenantId).put(member);
  }

  async reset(tenantId: string): Promise<void> {
    await Promise.all([this.depts(tenantId).reset(), this.staff(tenantId).reset()]);
  }
}
