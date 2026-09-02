/**
 * 体験シェル移行フラグの単体テスト (issue #422)。
 * 「既定は旧経路」「端末単位でクエリから切り戻せる」を固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KIOSK_EXPERIENCE_FLAGS,
  resolveKioskExperienceFlags,
} from './experience-flags';

describe('resolveKioskExperienceFlags', () => {
  it('未指定なら新経路（既定 true・台帳 B-02 で切替）', () => {
    // 旧個別 API を撤去する前提として既定を新経路へ倒した。切り戻しは env / クエリで行う。
    expect(resolveKioskExperienceFlags({})).toEqual(DEFAULT_KIOSK_EXPERIENCE_FLAGS);
    expect(resolveKioskExperienceFlags({ search: '', env: undefined }).effectiveConfiguration).toBe(
      true,
    );
  });

  it('ビルド時 env で明示的に新経路にできる', () => {
    for (const env of ['1', 'true', 'on', 'TRUE', ' 1 ']) {
      expect(resolveKioskExperienceFlags({ env }).effectiveConfiguration).toBe(true);
    }
  });

  it('ビルド時 env で環境ごと旧経路へ戻せる（撤去前の退避経路）', () => {
    for (const env of ['0', 'false', 'off']) {
      expect(resolveKioskExperienceFlags({ env }).effectiveConfiguration).toBe(false);
    }
  });

  it('env の不正値は既定（新経路）のまま — 誤入力で黙って旧経路へ落とさない', () => {
    for (const env of ['', 'yes', 'enabled']) {
      expect(resolveKioskExperienceFlags({ env }).effectiveConfiguration).toBe(true);
    }
  });

  it('クエリ ?effectiveConfig=1 で 1 台だけ新経路にできる', () => {
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=1' }).effectiveConfiguration,
    ).toBe(true);
    expect(
      resolveKioskExperienceFlags({ search: 'inactivityMs=500&effectiveConfig=true' })
        .effectiveConfiguration,
    ).toBe(true);
  });

  it('クエリ ?effectiveConfig=0 は env の有効化より優先する（端末単位の切り戻し）', () => {
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=0', env: '1' })
        .effectiveConfiguration,
    ).toBe(false);
  });

  it('クエリの不正値は env の指定を保つ（誤入力で挙動を反転させない）', () => {
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=maybe', env: '1' })
        .effectiveConfiguration,
    ).toBe(true);
    // env 未指定なら既定（新経路）へ。不正なクエリで黙って旧経路へ落とさない。
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=maybe' }).effectiveConfiguration,
    ).toBe(true);
    // 明示的な env=0 は不正クエリでも保たれる（切り戻しが誤入力で解除されない）。
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=maybe', env: '0' })
        .effectiveConfiguration,
    ).toBe(false);
  });
});
