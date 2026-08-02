import type { OrganizationUnit } from './types';

/**
 * 組織の編集入力（部分更新） (#373 増分 5)。
 *
 * ## この増分で編集できるもの
 *
 * 来訪者面の読み側（`listVisitorOrganizations`）が実際に消費するフィールドに絞る。
 * 消費者の無いフィールドを先に編集可能にしても、確かめようが無い。
 *
 * `parentId`（階層）は循環検証（`hierarchy.ts`）を伴うので別増分。`enabled` は互換側との
 * AND 合成（`mergeOrganizationUnits`）に載るため、閉じる方向の意味が旧 UI と絡む。
 * まず「表示名・並び・来訪者に出すか」だけを動かせるようにする。
 */
export type OrganizationUnitPatch = Partial<
  Pick<OrganizationUnit, 'publicDisplayName' | 'displayOrder' | 'publicInDirectory'>
>;

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: 'invalid_input'; message: string } };

function err(message: string): Result<never> {
  return { ok: false, error: { code: 'invalid_input', message } };
}

/** この増分で編集を許すキー。ここに無いものが来たら**黙って無視せず拒否する**。 */
const EDITABLE = ['publicDisplayName', 'displayOrder', 'publicInDirectory'] as const;

/**
 * 編集入力を検証する。
 *
 * ## 未知のキーは拒否する（無視しない）
 *
 * `id` / `tenantId` を書き換えられると別テナントの組織を作れてしまう。`parentId` は
 * 循環検証を伴うのでこの増分では扱えない。**黙って無視すると「送ったのに効かない」**
 * という、運用者から見て最も分かりにくい失敗になるので、明示的に拒否する。
 *
 * ## 空の公開表示名を通さない
 *
 * 読み側は公開表示名が空の組織を fail-closed で落とす（ラベルの無い押せるカードを作らない）。
 * 書き込みで通してしまうと「保存したのに来訪者画面に出ない」になり、運用者は原因に辿り着けない。
 */
export function validateOrganizationUnitPatch(input: unknown): Result<OrganizationUnitPatch> {
  if (typeof input !== 'object' || input === null) return err('body must be an object');
  const o = input as Record<string, unknown>;

  const unknownKeys = Object.keys(o).filter(
    (k) => !(EDITABLE as ReadonlyArray<string>).includes(k),
  );
  if (unknownKeys.length > 0) {
    return err(`not editable here: ${unknownKeys.join(', ')}`);
  }

  const patch: OrganizationUnitPatch = {};

  if ('publicDisplayName' in o) {
    if (typeof o.publicDisplayName !== 'string' || o.publicDisplayName.trim() === '') {
      return err('publicDisplayName must be a non-empty string');
    }
    patch.publicDisplayName = o.publicDisplayName.trim();
  }

  if ('displayOrder' in o) {
    if (typeof o.displayOrder !== 'number' || !Number.isFinite(o.displayOrder)) {
      return err('displayOrder must be a finite number');
    }
    patch.displayOrder = o.displayOrder;
  }

  if ('publicInDirectory' in o) {
    if (typeof o.publicInDirectory !== 'boolean') {
      return err('publicInDirectory must be a boolean');
    }
    patch.publicInDirectory = o.publicInDirectory;
  }

  // 空の patch を成功で返すと「保存できた」と見えるのに何も起きない。無音の成功を作らない。
  if (Object.keys(patch).length === 0) return err('no editable field given');

  return { ok: true, value: patch };
}
