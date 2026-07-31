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

  it('URL 未指定なら一覧を待たずに既定拠点で確定する', () => {
    // 曖昧さが無いので待つ必要が無い。ここで ready=false にすると初期表示が遅れる。
    expect(resolveSiteScopeState('', [], 'default-site')).toEqual({
      siteId: 'default-site',
      ready: true,
    });
  });

  it('URL 指定があり一覧が未取得なら **まだ確定しない**', () => {
    // ここで既定拠点を返して取得を始めると、deep link (?siteId=branch-site) のたびに
    // **間違った拠点への要求が先に飛ぶ**。応答順が入れ替わると、branch を選んでいるのに
    // default の内容が最後に届いて画面へ載る（そのまま保存すると他拠点の設定を壊す）。
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
});
