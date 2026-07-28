/**
 * デモ用途の版を「指定端末にだけ配る」ための解決ロジックのテスト
 * (issue #363 / `docs/adr/0005-demo-publication-and-experience-version.md` 手順 1 = additive)。
 *
 * ADR 0005 の決定:
 *  - 版モデルは `experience-version` へ一本化する
 *  - デモ固有の `test` 状態は**版の status を増やさず**「配信対象の指定」として表現する
 *    （status を増やすと `publishedVersion` の意味が揺れ、#420 の「公開版は 1 つ」が崩れる）
 *  - シナリオ（モック応答台本）は版に**埋めずに参照**する
 *
 * ここで解く問題: 「本番の端末には出さないが、実機で見たい」。
 * `publish` は前の公開版を archived にするので、デモ版を publish すると本番端末の
 * 配信先が消える。よってデモ版は **published にせず、指定端末にだけ配る**。
 *
 * 本 increment は additive のみ（デモ側は無変更・公開 API 不変）。ADR が挙げる
 * ユーザー判断 3 点（既存記録の移行・語彙統一のタイミング・応答形の維持）は手順 2 以降で、
 * ここでは触れない。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveVersionForDevice,
  isDeliverableTo,
  demoTargetedVersions,
} from './demo-delivery';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import type { ReceptionExperience, ReceptionExperienceVersion } from './types';

function version(
  revision: number,
  status: ReceptionExperienceVersion['status'],
  demoUse?: ReceptionExperienceVersion['demoUse'],
): ReceptionExperienceVersion {
  return {
    revision,
    status,
    configHash: `hash-${revision}`,
    createdBy: 'tester',
    createdAt: '2026-07-28T00:00:00.000Z',
    ...(demoUse ? { demoUse } : {}),
  };
}

function experience(versions: ReceptionExperienceVersion[]): ReceptionExperience {
  return {
    id: 'exp-1',
    tenantId: asTenantId('tenant-1'),
    siteId: asSiteId('site-1'),
    name: 'テスト受付',
    versions,
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

describe('isDeliverableTo — 版が指定端末へ配られるか', () => {
  it('デモ用途の指定が無い版は、どの端末にも配れる（通常の公開版）', () => {
    const v = version(1, 'published');
    expect(isDeliverableTo(v, 'kiosk-a')).toBe(true);
    expect(isDeliverableTo(v, 'kiosk-b')).toBe(true);
  });

  it('デモ用途の版は対象端末にだけ配れる', () => {
    const v = version(2, 'draft', { targetDeviceIds: ['kiosk-a'] });
    expect(isDeliverableTo(v, 'kiosk-a')).toBe(true);
    expect(isDeliverableTo(v, 'kiosk-b')).toBe(false);
  });

  it('対象が空配列なら、どの端末にも配らない（fail-closed）', () => {
    // 「配信対象を指定する」意図で作った版が、指定漏れで全端末へ出るのが最悪の事故。
    // 空 = 全部ではなく 空 = どこにも、に倒す。
    const v = version(2, 'draft', { targetDeviceIds: [] });
    expect(isDeliverableTo(v, 'kiosk-a')).toBe(false);
  });
});

describe('resolveVersionForDevice — 端末が受け取る版', () => {
  it('デモ指定が無ければ公開中の版を返す', () => {
    const exp = experience([version(1, 'published'), version(2, 'draft')]);
    expect(resolveVersionForDevice(exp, 'kiosk-a')?.revision).toBe(1);
  });

  it('デモ対象の端末はデモ版を受け取る（公開版より優先）', () => {
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
    ]);
    expect(resolveVersionForDevice(exp, 'kiosk-a')?.revision).toBe(2);
  });

  it('**対象外の端末は公開版のまま**（本番へ漏れない。本 increment の核心）', () => {
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
    ]);
    expect(resolveVersionForDevice(exp, 'kiosk-b')?.revision).toBe(1);
  });

  it('デモ版が複数あれば新しい revision が勝つ', () => {
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
      version(3, 'draft', { targetDeviceIds: ['kiosk-a'] }),
    ]);
    expect(resolveVersionForDevice(exp, 'kiosk-a')?.revision).toBe(3);
  });

  it('公開版が無く、デモ対象でもない端末は undefined', () => {
    const exp = experience([version(1, 'draft', { targetDeviceIds: ['kiosk-a'] })]);
    expect(resolveVersionForDevice(exp, 'kiosk-b')).toBeUndefined();
  });

  it('archived / rolled_back のデモ版は配らない（履歴に残るだけ）', () => {
    for (const status of ['archived', 'rolled_back'] as const) {
      const exp = experience([
        version(1, 'published'),
        version(2, status, { targetDeviceIds: ['kiosk-a'] }),
      ]);
      expect(resolveVersionForDevice(exp, 'kiosk-a')?.revision, status).toBe(1);
    }
  });

  it('版が 1 つも無ければ undefined', () => {
    expect(resolveVersionForDevice(experience([]), 'kiosk-a')).toBeUndefined();
  });
});

describe('「公開版は 1 つ」の不変条件を壊さない', () => {
  it('デモ版を足しても published は 1 つのまま', () => {
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
    ]);
    expect(exp.versions.filter((v) => v.status === 'published')).toHaveLength(1);
  });

  it('デモ版は published ではない（publish 経路を通さない）', () => {
    // publish は前の公開版を archived にするため、デモ版を publish すると
    // 本番端末の配信先が消える。デモは draft のまま指定端末へ配る。
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
    ]);
    const demo = exp.versions.find((v) => v.demoUse);
    expect(demo?.status).not.toBe('published');
  });
});

describe('demoTargetedVersions — 運用画面向けの一覧', () => {
  it('デモ用途の版だけを新しい順に返す', () => {
    const exp = experience([
      version(1, 'published'),
      version(2, 'draft', { targetDeviceIds: ['kiosk-a'] }),
      version(3, 'draft'),
      version(4, 'draft', { targetDeviceIds: ['kiosk-b'] }),
    ]);
    expect(demoTargetedVersions(exp).map((v) => v.revision)).toEqual([4, 2]);
  });

  it('デモ用途が無ければ空', () => {
    expect(demoTargetedVersions(experience([version(1, 'published')]))).toEqual([]);
  });
});

describe('シナリオは版に埋めず参照する（ADR 0005 決定 2）', () => {
  it('scenarioId は任意で、配信判定には影響しない', () => {
    const withScenario = version(2, 'draft', {
      targetDeviceIds: ['kiosk-a'],
      scenarioId: 'scenario-1',
    });
    const withoutScenario = version(3, 'draft', { targetDeviceIds: ['kiosk-a'] });
    expect(isDeliverableTo(withScenario, 'kiosk-a')).toBe(true);
    expect(isDeliverableTo(withoutScenario, 'kiosk-a')).toBe(true);
  });

  it('版はシナリオの中身を持たない（参照 ID だけ）', () => {
    const v = version(2, 'draft', { targetDeviceIds: ['kiosk-a'], scenarioId: 'scenario-1' });
    // 台本そのものを埋めると、版 = 構成の固定という意味が壊れる（ADR 0005 決定 2）。
    expect(Object.keys(v.demoUse!).sort()).toEqual(['scenarioId', 'targetDeviceIds']);
  });
});
