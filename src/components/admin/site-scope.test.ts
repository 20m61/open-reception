import { describe, expect, it } from 'vitest';
import { resolveSelectedSiteId, resolveSiteScope } from './site-scope';

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

describe('resolveSiteScope: 既定拠点を持つ画面向け (#421)', () => {
  it('拠点一覧の取得前は既定拠点へ倒す（空 id で取得しに行かない）', () => {
    // 営業時間・呼び出しルートの画面はサーバから既定拠点を prop で受け取り、初回描画で
    // すぐ取得を始める。一覧が届くまで '' を返すと **siteId 空のまま API を叩く**退行になる。
    expect(resolveSiteScope('', [], 'default-site')).toBe('default-site');
    expect(resolveSiteScope('branch-site', [], 'default-site')).toBe('default-site');
  });

  it('一覧が届いたら URL の指定を採用する', () => {
    const sites = [{ id: 'default-site' }, { id: 'branch-site' }];
    expect(resolveSiteScope('branch-site', sites, 'default-site')).toBe('branch-site');
  });

  it('一覧が届いた後も、実在しない指定は採用しない', () => {
    const sites = [{ id: 'default-site' }, { id: 'branch-site' }];
    expect(resolveSiteScope('no-such-site', sites, 'default-site')).toBe('default-site');
  });

  it('URL 未指定なら既定拠点を保つ（先頭へ勝手に動かさない）', () => {
    // 先頭は default-site だが、既定拠点が branch-site の環境（env 上書き）でも
    // 画面が勝手に別拠点へ切り替わらないことを固定する。
    const sites = [{ id: 'default-site' }, { id: 'branch-site' }];
    expect(resolveSiteScope('', sites, 'branch-site')).toBe('branch-site');
  });
});
