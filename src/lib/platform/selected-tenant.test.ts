/**
 * 対象テナント選択の純関数テスト (issue #83 inc3b / #90)。
 */
import { describe, expect, it } from 'vitest';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  resolveViewingContext,
  routeTenantIdFrom,
  selectedTenantLabel,
  SELECTED_TENANT_COOKIE,
} from './selected-tenant';

describe('parseSelectedTenantId', () => {
  /*
   * 🔴 **壊れたパーセントエンコードで投げない (#968 レビュー 8 周目 m1)。**
   *
   * ここは `TenantSwitcher` の `useEffect` 先頭から呼ばれるので、投げると**ヘッダごと**
   * 落ちる —— `src/app/platform/error.tsx` は layout の例外を捕まえないため、
   * `HeaderErrorBoundary` が唯一の受け皿になる。cookie は `httpOnly:false`（クライアントが
   * 読む前提）なので、第三者スクリプトがこの値を書ける。
   *
   * 同ファイルの `routeTenantIdFrom` は同じ関数を try/catch で囲んでおり、
   * **非対称だった**（レビューが実測して見つけた）。
   */
  it.each(['%', '%E0%A4%A', '100%'])('壊れたエンコード %s でも投げない', (broken) => {
    expect(() => parseSelectedTenantId(`${SELECTED_TENANT_COOKIE}=${broken}`)).not.toThrow();
    expect(parseSelectedTenantId(`${SELECTED_TENANT_COOKIE}=${broken}`)).toBeNull();
  });

  it('壊れた cookie が他の cookie を巻き込まない', () => {
    expect(() => parseSelectedTenantId(`a=1; ${SELECTED_TENANT_COOKIE}=%; b=2`)).not.toThrow();
  });

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

describe('routeTenantIdFrom: URL が名指しするテナント (#423 配線)', () => {
  it('テナント詳細のパスから id を取る', () => {
    expect(routeTenantIdFrom('/platform/tenants/acme')).toBe('acme');
  });

  it('詳細より深いパスでも取れる（子ページを増やしても壊れない）', () => {
    expect(routeTenantIdFrom('/platform/tenants/acme/devices')).toBe('acme');
  });

  it('一覧ページはテナントを名指ししていない', () => {
    expect(routeTenantIdFrom('/platform/tenants')).toBeNull();
    expect(routeTenantIdFrom('/platform/tenants/')).toBeNull();
  });

  it('platform 以外・空・未知のパスは null', () => {
    for (const path of ['', '/', '/platform', '/admin/tenants/acme', '/kiosk']) {
      expect(routeTenantIdFrom(path), path).toBeNull();
    }
  });

  it('URL エンコードされた id を復号する', () => {
    expect(routeTenantIdFrom('/platform/tenants/a%2Fb')).toBe('a/b');
  });
});

describe('resolveViewingContext: いま見ているテナントの表示 (#423 配線)', () => {
  const tenants = [
    { id: 't1', name: 'アクメ商事' },
    { id: 't2', name: 'ベータ工業' },
  ];

  it('URL がテナントを名指ししていれば、その名前を出す', () => {
    // これが本題。ヘッダが sticky だけを出していたため、`/platform/tenants/t1` を見ているのに
    // ヘッダが別テナントや「全テナント横断」を示していた。
    const view = resolveViewingContext({
      pathname: '/platform/tenants/t1',
      stickyTenantId: 't2',
      tenants,
    });
    expect(view.tenantName).toBe('アクメ商事');
    expect(view.differsFromSticky).toBe(true);
  });

  it('sticky が未選択（全テナント横断）でも、URL のテナントは出す', () => {
    // `differsFromSticky` は false だが**表示は必要**。ここを取り違えると
    // 「全テナント横断」と表示しながら 1 テナントの詳細を見ている状態が残る。
    const view = resolveViewingContext({
      pathname: '/platform/tenants/t1',
      stickyTenantId: null,
      tenants,
    });
    expect(view.tenantName).toBe('アクメ商事');
    expect(view.differsFromSticky).toBe(false);
  });

  it('URL と sticky が一致していれば警告は出さない', () => {
    const view = resolveViewingContext({
      pathname: '/platform/tenants/t1',
      stickyTenantId: 't1',
      tenants,
    });
    expect(view.tenantName).toBe('アクメ商事');
    expect(view.differsFromSticky).toBe(false);
  });

  it('URL が名指ししていない画面では何も出さない（sticky は select が示している）', () => {
    const view = resolveViewingContext({
      pathname: '/platform/tenants',
      stickyTenantId: 't2',
      tenants,
    });
    expect(view.tenantName).toBeNull();
  });

  it('**権威に無い id は出さない**（URL は誰でも打てる）', () => {
    const view = resolveViewingContext({
      pathname: '/platform/tenants/not-mine',
      stickyTenantId: 't2',
      tenants,
    });
    expect(view.tenantName).toBeNull();
  });

  it('一覧が未取得（fetch 前）なら出さない（偽の表示を作らない）', () => {
    const view = resolveViewingContext({
      pathname: '/platform/tenants/t1',
      stickyTenantId: null,
      tenants: [],
    });
    expect(view.tenantName).toBeNull();
  });
});
