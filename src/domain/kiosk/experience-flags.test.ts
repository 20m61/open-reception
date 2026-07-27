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
  it('未指定なら旧経路（既定 false）', () => {
    expect(resolveKioskExperienceFlags({})).toEqual(DEFAULT_KIOSK_EXPERIENCE_FLAGS);
    expect(resolveKioskExperienceFlags({ search: '', env: undefined }).effectiveConfiguration).toBe(
      false,
    );
  });

  it('ビルド時 env で既定を新経路にできる', () => {
    for (const env of ['1', 'true', 'on', 'TRUE', ' 1 ']) {
      expect(resolveKioskExperienceFlags({ env }).effectiveConfiguration).toBe(true);
    }
  });

  it('env の偽値・不正値は旧経路のまま', () => {
    for (const env of ['0', 'false', 'off', '', 'yes', 'enabled']) {
      expect(resolveKioskExperienceFlags({ env }).effectiveConfiguration).toBe(false);
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
    expect(
      resolveKioskExperienceFlags({ search: '?effectiveConfig=maybe' }).effectiveConfiguration,
    ).toBe(false);
  });
});
