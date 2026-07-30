import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/domain/tenant/types';
import { resolveAreaSwitch } from './area-switch';

/**
 * エリア切替導線 (#423「developer ロール時のみ platform への切替導線を表示」)。
 *
 * これは**導線であって認可ではない**。認可は `canEnterArea`（layout）と各 API が行う。
 * 出さないことは保護ではないので、ここでの判定を保護の根拠にしてはいけない。
 */
const DEVELOPER: readonly TenantRole[] = ['developer'];
const TENANT_ADMIN: readonly TenantRole[] = ['tenant_admin'];

describe('resolveAreaSwitch: admin → platform', () => {
  it('developer には platform への導線を出す', () => {
    const target = resolveAreaSwitch('admin', DEVELOPER);
    expect(target?.href).toBe('/platform');
    expect(target?.area).toBe('platform');
    expect(target?.label).not.toBe('');
  });

  it('developer は他ロールと併せ持っていても出す', () => {
    // 実 actor は assignment ごとにロールを持つので複数になり得る（rolesFromActor は重複除去のみ）。
    expect(resolveAreaSwitch('admin', ['tenant_admin', 'developer'])?.href).toBe('/platform');
  });

  it('非 developer には出さない', () => {
    expect(resolveAreaSwitch('admin', TENANT_ADMIN)).toBeNull();
    expect(resolveAreaSwitch('admin', ['site_manager'])).toBeNull();
    expect(resolveAreaSwitch('admin', ['viewer'])).toBeNull();
  });

  it('ロールが空でも壊れない（未解決 actor の描画）', () => {
    expect(resolveAreaSwitch('admin', [])).toBeNull();
  });
});

describe('resolveAreaSwitch: platform → admin', () => {
  /**
   * platform に居られる時点で developer であることは `canEnterArea` が保証している
   * （platform は scope:'all' のみ許可）。そして developer は admin へも入れる
   * （admin は「何らかのテナントにアクセスできる」で、scope:'all' は満たす）。
   * よって戻り導線は無条件でよい — **行き止まりを作らない**。
   */
  it('常に admin への戻り導線を出す', () => {
    expect(resolveAreaSwitch('platform', DEVELOPER)?.href).toBe('/admin');
    expect(resolveAreaSwitch('platform', DEVELOPER)?.area).toBe('admin');
  });

  it('ロールが空でも戻り導線は消えない（戻れなくなる方が有害）', () => {
    expect(resolveAreaSwitch('platform', [])?.href).toBe('/admin');
  });
});
