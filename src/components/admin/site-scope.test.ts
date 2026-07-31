import { describe, expect, it } from 'vitest';
import { resolveSelectedSiteId, resolveSiteScopeState } from './site-scope';

const sites = [{ id: 'site-a' }, { id: 'site-b' }];

describe('resolveSelectedSiteId: URL の siteId と実在サイトの突き合わせ (#421)', () => {
  it('実在する siteId が指定されていればそれを採用する（深いリンクが効く）', () => {
    expect(resolveSelectedSiteId('site-b', sites)).toBe('site-b');
  });

  it('未指定なら先頭のサイトへ倒す（既存の自動選択を保つ）', () => {
    expect(resolveSelectedSiteId('', sites)).toBe('site-a');
  });

  it('実在しない siteId は採用せず先頭へ倒す', () => {
    // URL は利用者が自由に書ける入力である。存在しない（あるいは権限外で一覧に出てこない）
    // id をそのまま選択状態にすると、**空の一覧を「この拠点には端末が無い」と誤読させる**。
    // 選択中テナント cookie を検証してから使う `resolveActiveTenantId` と同じ安全側の倒し方。
    expect(resolveSelectedSiteId('site-zzz', sites)).toBe('site-a');
  });

  it('サイトが 1 件も無ければ空文字（未選択）', () => {
    expect(resolveSelectedSiteId('site-a', [])).toBe('');
    expect(resolveSelectedSiteId('', [])).toBe('');
  });
});

describe('resolveSiteScopeState: 既定拠点を持つ画面向け (#421)', () => {
  const sites = [{ id: 'default-site' }, { id: 'branch-site' }];

  it('URL 指定が無くても、一覧が届くまでは確定しない', () => {
    // **既定拠点が選択中テナントに在るとは限らない。** `resolveDefaultScope()` は env 由来の
    // グローバル既定なので、テナントを切り替えると存在しない拠点を指しうる。そのまま
    // 確定させると `<選択中テナント>/default-site` を読み書きし、developer / tenant_admin は
    // 任意の siteId を通せるため**実在しない拠点の下にデータを作れてしまう**。
    expect(resolveSiteScopeState('', [], 'default-site')).toEqual({
      siteId: 'default-site',
      ready: false,
    });
  });

  it('URL 指定があり一覧が未取得なら確定しない', () => {
    expect(resolveSiteScopeState('branch-site', [], 'default-site')).toEqual({
      siteId: 'default-site',
      ready: false,
    });
  });

  it('一覧が届いたら URL の指定を採用して確定する', () => {
    expect(resolveSiteScopeState('branch-site', sites, 'default-site')).toEqual({
      siteId: 'branch-site',
      ready: true,
    });
  });

  it('一覧が届いた後も、実在しない指定は採用しない', () => {
    expect(resolveSiteScopeState('no-such-site', sites, 'default-site')).toEqual({
      siteId: 'default-site',
      ready: true,
    });
  });

  it('URL 未指定なら既定拠点を保つ（先頭へ勝手に動かさない）', () => {
    expect(resolveSiteScopeState('', sites, 'branch-site')).toEqual({
      siteId: 'branch-site',
      ready: true,
    });
  });

  it('既定拠点が選択中テナントに無ければ、そのテナントの先頭へ倒す', () => {
    // 実在しない拠点を掴んだままにしない。
    const other = [{ id: 'tenant-b-site-1' }, { id: 'tenant-b-site-2' }];
    expect(resolveSiteScopeState('', other, 'default-site')).toEqual({
      siteId: 'tenant-b-site-1',
      ready: true,
    });
  });

  it('サイトが 1 件も無いテナントでは確定しない（空 id で読み書きさせない）', () => {
    expect(resolveSiteScopeState('', [], '')).toEqual({ siteId: '', ready: false });
  });
});
