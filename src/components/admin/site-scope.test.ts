import { describe, expect, it } from 'vitest';
import { resolveSelectedSiteId } from './site-scope';

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
