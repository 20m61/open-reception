import { describe, expect, it } from 'vitest';
import { resolveVersionActions, type VersionActionInput } from './experience-version-actions';
import type { ReceptionExperienceVersion } from '@/domain/experience-version/types';

function version(over: Partial<ReceptionExperienceVersion> = {}): ReceptionExperienceVersion {
  return {
    revision: 5,
    status: 'draft',
    configHash: 'hash-5',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as ReceptionExperienceVersion;
}

function input(over: Partial<VersionActionInput> = {}): VersionActionInput {
  return {
    scopeReady: true,
    sitePending: false,
    busy: false,
    versionsLoaded: true,
    draft: version({ approvedBy: 'admin' }),
    published: version({ revision: 4, status: 'published', publishedAt: '2026-01-02T00:00:00.000Z' }),
    rollbackTarget: version({ revision: 3, status: 'archived', publishedAt: '2026-01-01T00:00:00.000Z' }),
    ...over,
  };
}

describe('resolveVersionActions (#554)', () => {
  it('通常は版を名指しする操作も押せる', () => {
    expect(resolveVersionActions(input())).toMatchObject({
      'save-draft': true,
      publish: true,
      rollback: true,
    });
  });

  describe('拠点が確定していない / 切替中', () => {
    it.each([
      ['scopeReady=false', { scopeReady: false }],
      ['sitePending=true', { sitePending: true }],
      ['busy=true', { busy: true }],
    ])('%s では全操作を止める', (_label, over) => {
      const actions = resolveVersionActions(input(over));
      expect(Object.values(actions).every((v) => v === false)).toBe(true);
    });
  });

  describe('表示中の版が現在の拠点のものでないとき', () => {
    it('版を名指しする操作は止める', () => {
      // `revision` は experience ごとの連番で拠点間で衝突する。前拠点の rev.5 を掴んだまま
      // 新拠点へ投げると**別拠点の rev.5 を公開/巻き戻す**。
      const actions = resolveVersionActions(input({ versionsLoaded: false }));
      expect(actions.approve).toBe(false);
      expect(actions.publish).toBe(false);
      expect(actions.rollback).toBe(false);
    });

    it('**下書き保存は止めない**（読み取りの失敗で書き込みを殺さない）', () => {
      // 一覧 GET が失敗しただけで「現在の設定を版として固定する」復旧経路が永久に止まる
      // のを避ける。この操作は版一覧を参照しない。
      expect(resolveVersionActions(input({ versionsLoaded: false }))['save-draft']).toBe(true);
    });
  });

  describe('版の状態による可否', () => {
    it('下書きが無ければ承認・公開はできない', () => {
      const actions = resolveVersionActions(input({ draft: undefined }));
      expect(actions.approve).toBe(false);
      expect(actions.publish).toBe(false);
    });

    it('承認済みの下書きは再承認できない', () => {
      expect(resolveVersionActions(input()).approve).toBe(false);
    });

    it('未承認の下書きは承認できるが公開はできない', () => {
      const actions = resolveVersionActions(input({ draft: version({ approvedBy: undefined }) }));
      expect(actions.approve).toBe(true);
      expect(actions.publish).toBe(false);
    });

    it('切り戻し先が無ければ切り戻せない', () => {
      expect(resolveVersionActions(input({ rollbackTarget: undefined })).rollback).toBe(false);
    });

    it('公開中の版が無ければ切り戻せない', () => {
      expect(resolveVersionActions(input({ published: undefined })).rollback).toBe(false);
    });
  });
});
