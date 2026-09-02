import { describe, expect, it } from 'vitest';
import {
  hasValidationErrors,
  sortDeploymentRows,
  summaryText,
  versionStateLabel,
} from './deployment-view';
import type { ReceptionExperienceVersion } from './types';

function version(over: Partial<ReceptionExperienceVersion> = {}): ReceptionExperienceVersion {
  return {
    revision: 1,
    status: 'draft',
    configHash: 'sha256:aaa',
    createdBy: 'admin-1',
    createdAt: '2026-07-27T00:00:00.000Z',
    ...over,
  };
}

describe('sortDeploymentRows', () => {
  it('対処が要る順（失敗 → 旧版 → 未反映 → 反映済み）に並べる', () => {
    const rows = sortDeploymentRows([
      { kioskId: 'k1', status: 'applied' },
      { kioskId: 'k2', status: 'pending' },
      { kioskId: 'k3', status: 'failed' },
      { kioskId: 'k4', status: 'stale' },
    ]);

    expect(rows.map((r) => r.kioskId)).toEqual(['k3', 'k4', 'k2', 'k1']);
  });

  it('同じ状態なら端末 ID 順（決定的）', () => {
    const rows = sortDeploymentRows([
      { kioskId: 'kiosk-b', status: 'pending' },
      { kioskId: 'kiosk-a', status: 'pending' },
    ]);

    expect(rows.map((r) => r.kioskId)).toEqual(['kiosk-a', 'kiosk-b']);
  });

  it('入力を破壊しない', () => {
    const input = [
      { kioskId: 'k1', status: 'applied' as const },
      { kioskId: 'k2', status: 'failed' as const },
    ];
    sortDeploymentRows(input);
    expect(input[0]?.kioskId).toBe('k1');
  });
});

describe('summaryText', () => {
  it('全台反映済みなら完了として出す', () => {
    expect(
      summaryText({ total: 3, applied: 3, pending: 0, stale: 0, failed: 0, complete: true }),
    ).toBe('全 3 台が反映済み');
  });

  it('未完了は内訳を出す', () => {
    expect(
      summaryText({ total: 4, applied: 1, pending: 1, stale: 1, failed: 1, complete: false }),
    ).toBe('1/4 台が反映済み / 失敗 1 / 旧版 1 / 未反映 1');
  });

  it('0 件や未公開を「完了」と読ませない', () => {
    expect(summaryText(null)).toBe('対象端末がありません');
    expect(
      summaryText({ total: 0, applied: 0, pending: 0, stale: 0, failed: 0, complete: false }),
    ).toBe('対象端末がありません');
  });
});

describe('versionStateLabel', () => {
  it('版の状態を 1 語で表す', () => {
    expect(versionStateLabel(version({ status: 'published' }))).toBe('公開中');
    expect(versionStateLabel(version({ status: 'draft' }))).toBe('下書き');
    expect(versionStateLabel(version({ status: 'draft', approvedBy: 'admin-2' }))).toBe(
      '承認済み（未公開）',
    );
    expect(versionStateLabel(version({ status: 'rolled_back' }))).toBe('切り戻し済み');
    expect(versionStateLabel(version({ status: 'archived' }))).toBe('過去版');
  });

  it('切り戻しで作られた公開版は復元元を添える', () => {
    expect(versionStateLabel(version({ status: 'published', rolledBackFrom: 2 }))).toBe(
      '公開中（rev.2 へ切り戻し）',
    );
  });
});

describe('hasValidationErrors', () => {
  it('error のみをブロック扱いにする', () => {
    expect(hasValidationErrors(version())).toBe(false);
    expect(
      hasValidationErrors(
        version({
          validationSummary: {
            checkedAt: '2026-07-27T00:00:00.000Z',
            findings: [{ check: 'asset', severity: 'warning', message: 'w' }],
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasValidationErrors(
        version({
          validationSummary: {
            checkedAt: '2026-07-27T00:00:00.000Z',
            findings: [{ check: 'permission', severity: 'error', message: 'e' }],
          },
        }),
      ),
    ).toBe(true);
  });
});
