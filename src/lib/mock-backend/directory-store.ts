/**
 * 部署・担当者ディレクトリのストア (issue #3)。
 * 受付端末・管理画面・呼び出し adapter の単一の情報源とする。
 *
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 * memory バックエンドでは mock-data を seed として読み込む。
 */
import type { Department } from '@/domain/department/types';
import { normalizeCallTargets, type MockCallOutcome, type Staff } from '@/domain/staff/types';
import { MOCK_DEPARTMENTS, MOCK_STAFF } from '@/domain/staff/mock-data';
import { searchStaff } from '@/domain/staff/search';
import { getBackend } from '@/lib/data';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const depts = () =>
  getBackend().collection<Department>('department', {
    seed: () => MOCK_DEPARTMENTS.map((d) => ({ ...d })),
  });
const staffCol = () =>
  getBackend().collection<Staff>('staff', {
    seed: () => MOCK_STAFF.map((s) => ({ ...s, aliases: [...s.aliases] })),
  });

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function nextId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------- 部署 ---------- */

export async function listDepartments(includeDisabled = false): Promise<Department[]> {
  const all = await depts().list();
  return all
    .filter((d) => includeDisabled || d.enabled)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

export async function getDepartment(id: string): Promise<Result<Department>> {
  const found = await depts().get(id);
  return found ? { ok: true, value: found } : err('not_found', 'department not found');
}

export type DepartmentInput = { name: string; kana?: string; enabled?: boolean };

function validateDepartmentInput(input: unknown): Result<DepartmentInput> {
  if (typeof input !== 'object' || input === null) return err('invalid_input', 'body must be an object');
  const o = input as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim() === '') return err('invalid_input', 'name is required');
  return {
    ok: true,
    value: {
      name: o.name.trim(),
      kana: typeof o.kana === 'string' ? o.kana : undefined,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
    },
  };
}

export async function createDepartment(input: unknown): Promise<Result<Department>> {
  const v = validateDepartmentInput(input);
  if (!v.ok) return v;
  const all = await depts().list();
  const maxOrder = all.reduce((m, d) => Math.max(m, d.displayOrder), 0);
  const dept: Department = {
    id: nextId('dept'),
    name: v.value.name,
    kana: v.value.kana,
    displayOrder: maxOrder + 1,
    enabled: v.value.enabled ?? true,
  };
  await depts().put(dept);
  return { ok: true, value: dept };
}

export async function updateDepartment(id: string, patch: unknown): Promise<Result<Department>> {
  const found = await depts().get(id);
  if (!found) return err('not_found', 'department not found');
  if (typeof patch !== 'object' || patch === null) return err('invalid_input', 'body must be an object');
  const o = patch as Record<string, unknown>;
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || o.name.trim() === '') return err('invalid_input', 'name is invalid');
    found.name = o.name.trim();
  }
  if (o.kana !== undefined) found.kana = typeof o.kana === 'string' ? o.kana : undefined;
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return err('invalid_input', 'enabled must be boolean');
    found.enabled = o.enabled;
  }
  if (o.displayOrder !== undefined) {
    if (typeof o.displayOrder !== 'number') return err('invalid_input', 'displayOrder must be a number');
    found.displayOrder = o.displayOrder;
  }
  await depts().put(found);
  return { ok: true, value: found };
}

/** 指定した順序で部署の表示順を一括設定する（DnD 並び替え用） (issue #25)。 */
export async function reorderDepartments(orderedIds: unknown): Promise<Result<Department[]>> {
  if (!Array.isArray(orderedIds) || !orderedIds.every((id): id is string => typeof id === 'string')) {
    return err('invalid_input', 'orderedIds must be an array of string');
  }
  const all = await depts().list();
  const known = new Set(all.map((d) => d.id));
  if (!orderedIds.every((id) => known.has(id))) {
    return err('invalid_input', 'orderedIds contains unknown department id');
  }
  for (const [index, id] of orderedIds.entries()) {
    const dept = all.find((d) => d.id === id);
    if (dept) {
      dept.displayOrder = index + 1;
      await depts().put(dept);
    }
  }
  return { ok: true, value: await listDepartments(true) };
}

/** 部署を1つ上/下へ並び替える (issue #25)。 */
export async function moveDepartment(id: string, direction: 'up' | 'down'): Promise<Result<Department[]>> {
  const ordered = await listDepartments(true);
  const index = ordered.findIndex((d) => d.id === id);
  if (index === -1) return err('not_found', 'department not found');
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ordered.length) return { ok: true, value: ordered };
  const a = ordered[index]!;
  const b = ordered[swapWith]!;
  const tmp = a.displayOrder;
  a.displayOrder = b.displayOrder;
  b.displayOrder = tmp;
  await depts().put(a);
  await depts().put(b);
  return { ok: true, value: await listDepartments(true) };
}

/* ---------- 担当者 ---------- */

export async function listStaff(includeDisabled = false): Promise<Staff[]> {
  const all = await staffCol().list();
  return all.filter((s) => includeDisabled || s.enabled);
}

export async function getStaff(id: string): Promise<Result<Staff>> {
  const found = await staffCol().get(id);
  return found ? { ok: true, value: found } : err('not_found', 'staff not found');
}

export async function searchEnabledStaff(query: string): Promise<Staff[]> {
  return searchStaff(await staffCol().list(), query);
}

export type StaffInput = {
  displayName: string;
  kana?: string;
  aliases?: string[];
  departmentId: string;
  enabled?: boolean;
  available?: boolean;
  mockCallOutcome?: MockCallOutcome;
};

function validateStaffInput(input: unknown, knownDeptIds: Set<string>): Result<StaffInput> {
  if (typeof input !== 'object' || input === null) return err('invalid_input', 'body must be an object');
  const o = input as Record<string, unknown>;
  if (typeof o.displayName !== 'string' || o.displayName.trim() === '')
    return err('invalid_input', 'displayName is required');
  if (typeof o.departmentId !== 'string' || !knownDeptIds.has(o.departmentId))
    return err('invalid_input', 'departmentId is invalid');
  const aliases = Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === 'string') : undefined;
  return {
    ok: true,
    value: {
      displayName: o.displayName.trim(),
      kana: typeof o.kana === 'string' ? o.kana : undefined,
      aliases,
      departmentId: o.departmentId,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
      available: typeof o.available === 'boolean' ? o.available : undefined,
    },
  };
}

export async function createStaff(input: unknown): Promise<Result<Staff>> {
  const deptIds = new Set((await depts().list()).map((d) => d.id));
  const v = validateStaffInput(input, deptIds);
  if (!v.ok) return v;
  const member: Staff = {
    id: nextId('staff'),
    displayName: v.value.displayName,
    kana: v.value.kana,
    aliases: v.value.aliases ?? [],
    departmentId: v.value.departmentId,
    enabled: v.value.enabled ?? true,
    available: v.value.available ?? true,
    callTargets: [],
    fallbackStaffIds: [],
  };
  await staffCol().put(member);
  return { ok: true, value: member };
}

export async function updateStaff(id: string, patch: unknown): Promise<Result<Staff>> {
  const found = await staffCol().get(id);
  if (!found) return err('not_found', 'staff not found');
  if (typeof patch !== 'object' || patch === null) return err('invalid_input', 'body must be an object');
  const o = patch as Record<string, unknown>;
  if (o.displayName !== undefined) {
    if (typeof o.displayName !== 'string' || o.displayName.trim() === '')
      return err('invalid_input', 'displayName is invalid');
    found.displayName = o.displayName.trim();
  }
  if (o.kana !== undefined) found.kana = typeof o.kana === 'string' ? o.kana : undefined;
  if (o.departmentId !== undefined) {
    const deptIds = new Set((await depts().list()).map((d) => d.id));
    if (typeof o.departmentId !== 'string' || !deptIds.has(o.departmentId))
      return err('invalid_input', 'departmentId is invalid');
    found.departmentId = o.departmentId;
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return err('invalid_input', 'enabled must be boolean');
    found.enabled = o.enabled;
  }
  if (o.available !== undefined) {
    if (typeof o.available !== 'boolean') return err('invalid_input', 'available must be boolean');
    found.available = o.available;
  }
  if (o.callTargets !== undefined) {
    // 配列順を優先順位として正規化する（DnD 並び替えの確定）。
    found.callTargets = normalizeCallTargets(o.callTargets);
  }
  if (o.fallbackStaffIds !== undefined) {
    if (!Array.isArray(o.fallbackStaffIds)) return err('invalid_input', 'fallbackStaffIds must be an array');
    const allStaff = await staffCol().list();
    const valid = o.fallbackStaffIds
      .filter((sid): sid is string => typeof sid === 'string')
      .filter((sid) => sid !== id && allStaff.some((s) => s.id === sid));
    found.fallbackStaffIds = valid;
  }
  await staffCol().put(found);
  return { ok: true, value: found };
}

/* ---------- CSV インポート (issue #25, #26) ---------- */

export type ImportSummary = {
  mode: 'preview' | 'apply';
  created: number;
  updated: number;
  invalid: Array<{ row: number; reason: string }>;
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/** 部署 CSV（department_id,name,kana,display_order,enabled）を取り込む。 */
export async function importDepartments(
  records: Record<string, string>[],
  mode: 'preview' | 'apply',
): Promise<ImportSummary> {
  const summary: ImportSummary = { mode, created: 0, updated: 0, invalid: [] };
  const current = await depts().list();
  let maxOrder = current.reduce((m, d) => Math.max(m, d.displayOrder), 0);
  for (const [i, rec] of records.entries()) {
    const name = (rec.name ?? '').trim();
    if (name === '') {
      summary.invalid.push({ row: i + 2, reason: 'name is required' });
      continue;
    }
    const id = (rec.department_id ?? '').trim();
    const existing = id ? current.find((d) => d.id === id) : undefined;
    if (existing) {
      summary.updated++;
      if (mode === 'apply') {
        existing.name = name;
        existing.kana = rec.kana?.trim() || undefined;
        if (rec.display_order) existing.displayOrder = Number(rec.display_order) || existing.displayOrder;
        existing.enabled = parseBool(rec.enabled, existing.enabled);
        await depts().put(existing);
      }
    } else {
      summary.created++;
      if (mode === 'apply') {
        const order = rec.display_order ? Number(rec.display_order) || ++maxOrder : ++maxOrder;
        const dept: Department = {
          id: id || nextId('dept'),
          name,
          kana: rec.kana?.trim() || undefined,
          displayOrder: order,
          enabled: parseBool(rec.enabled, true),
        };
        current.push(dept);
        await depts().put(dept);
      }
    }
  }
  return summary;
}

/** 担当者 CSV（staff_id,display_name,kana,aliases,department_id,enabled,available）を取り込む。 */
export async function importStaff(
  records: Record<string, string>[],
  mode: 'preview' | 'apply',
): Promise<ImportSummary> {
  const summary: ImportSummary = { mode, created: 0, updated: 0, invalid: [] };
  const deptIds = new Set((await depts().list()).map((d) => d.id));
  const current = await staffCol().list();
  for (const [i, rec] of records.entries()) {
    const displayName = (rec.display_name ?? '').trim();
    const departmentId = (rec.department_id ?? '').trim();
    if (displayName === '') {
      summary.invalid.push({ row: i + 2, reason: 'display_name is required' });
      continue;
    }
    if (!deptIds.has(departmentId)) {
      summary.invalid.push({ row: i + 2, reason: `unknown department_id: ${departmentId}` });
      continue;
    }
    const aliases = (rec.aliases ?? '')
      .split(';')
      .map((a) => a.trim())
      .filter((a) => a !== '');
    const id = (rec.staff_id ?? '').trim();
    const existing = id ? current.find((s) => s.id === id) : undefined;
    if (existing) {
      summary.updated++;
      if (mode === 'apply') {
        existing.displayName = displayName;
        existing.kana = rec.kana?.trim() || undefined;
        existing.aliases = aliases;
        existing.departmentId = departmentId;
        existing.enabled = parseBool(rec.enabled, existing.enabled);
        existing.available = parseBool(rec.available, existing.available);
        await staffCol().put(existing);
      }
    } else {
      summary.created++;
      if (mode === 'apply') {
        const fallbackStaffIds = (rec.fallback_staff_ids ?? '')
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        const member: Staff = {
          id: id || nextId('staff'),
          displayName,
          kana: rec.kana?.trim() || undefined,
          aliases,
          departmentId,
          enabled: parseBool(rec.enabled, true),
          available: parseBool(rec.available, true),
          callTargets: [],
          fallbackStaffIds,
        };
        current.push(member);
        await staffCol().put(member);
      }
    }
  }
  return summary;
}

/* ---------- kiosk 公開ビュー ---------- */

/** 受付端末向けの最小情報（mockCallOutcome 等の内部情報は含めない）。 */
export type KioskStaff = { id: string; displayName: string; kana?: string; aliases: string[]; departmentId: string; available: boolean };
export type KioskDirectory = {
  departments: Array<Pick<Department, 'id' | 'name'>>;
  staff: KioskStaff[];
};

export async function getKioskDirectory(): Promise<KioskDirectory> {
  const [departments, staff] = await Promise.all([listDepartments(false), listStaff(false)]);
  return {
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    // 検索に必要な kana/aliases は含めるが、内部用の mockCallOutcome/available は含めない。
    staff: staff.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      kana: s.kana,
      aliases: s.aliases,
      departmentId: s.departmentId,
      available: s.available,
    })),
  };
}

/** テスト用: ストアを seed 状態に戻す。 */
export async function __resetDirectory(): Promise<void> {
  await Promise.all([depts().reset(), staffCol().reset()]);
}
