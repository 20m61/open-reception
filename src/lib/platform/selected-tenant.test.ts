/**
 * 対象テナント選択の純関数テスト (issue #83 inc3b / #90)。
 */
import { describe, expect, it } from 'vitest';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  selectedTenantLabel,
  SELECTED_TENANT_COOKIE,
} from './selected-tenant';

describe('parseSelectedTenantId', () => {
  it('Cookie 文字列から対象テナント id を取り出す', () => {
    expect(parseSelectedTenantId(`a=1; ${SELECTED_TENANT_COOKIE}=internal; b=2`)).toBe('internal');
  });
  it('URL エンコードされた値をデコードする', () => {
    expect(parseSelectedTenantId(`${SELECTED_TENANT_COOKIE}=ten%20a`)).toBe('ten a');
  });
  it('未設定・空・空文字値は null（全テナント横断）', () => {
    expect(parseSelectedTenantId(undefined)).toBeNull();
    expect(parseSelectedTenantId('')).toBeNull();
    expect(parseSelectedTenantId('other=x')).toBeNull();
    expect(parseSelectedTenantId(`${SELECTED_TENANT_COOKIE}=`)).toBeNull();
  });
});

describe('resolveSelectedTenant', () => {
  const tenants = [
    { id: 'internal', name: '社内' },
    { id: 'acme', name: 'Acme' },
  ];
  it('選択 id に一致するテナントを返す', () => {
    expect(resolveSelectedTenant(tenants, 'acme')).toEqual({ id: 'acme', name: 'Acme' });
  });
  it('null / 存在しない id は null（横断へフォールバック）', () => {
    expect(resolveSelectedTenant(tenants, null)).toBeNull();
    expect(resolveSelectedTenant(tenants, 'ghost')).toBeNull();
  });
});

describe('selectedTenantLabel', () => {
  it('未選択は全テナント横断、選択時は名称', () => {
    expect(selectedTenantLabel(null)).toBe('全テナント横断');
    expect(selectedTenantLabel({ id: 'acme', name: 'Acme' })).toBe('Acme');
  });
});
