/**
 * 公開/共有パネルの純粋な表示ロジック (issue #363 Inc3 UI)。
 */
import { describe, expect, it } from 'vitest';
import type { Kiosk } from '@/domain/kiosk/types';
import {
  canIssueShare,
  canRevokeShare,
  canShowRollback,
  selectableTargets,
  shareStatus,
  targetLabel,
} from './publish-panel';

const NOW = Date.parse('2026-07-22T00:00:00.000Z');

describe('shareStatus', () => {
  it('未発行は none', () => {
    expect(shareStatus(undefined, NOW)).toBe('none');
  });
  it('失効済みは revoked（期限内でも）', () => {
    expect(
      shareStatus(
        { issuedAt: '2026-07-21T00:00:00.000Z', expiresAt: '2026-07-23T00:00:00.000Z', revokedAt: '2026-07-21T12:00:00.000Z' },
        NOW,
      ),
    ).toBe('revoked');
  });
  it('期限切れは expired', () => {
    expect(
      shareStatus({ issuedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-21T00:00:00.000Z' }, NOW),
    ).toBe('expired');
  });
  it('期限内・未失効は active', () => {
    expect(
      shareStatus({ issuedAt: '2026-07-21T00:00:00.000Z', expiresAt: '2026-07-23T00:00:00.000Z' }, NOW),
    ).toBe('active');
  });
});

describe('canIssueShare', () => {
  it('draft/test は発行不可', () => {
    expect(canIssueShare('draft', undefined, NOW)).toBe(false);
    expect(canIssueShare('test', undefined, NOW)).toBe(false);
  });
  it('published かつ未発行なら発行可', () => {
    expect(canIssueShare('published', undefined, NOW)).toBe(true);
  });
  it('published かつ有効な共有が既にあるなら発行不可（再発行は先に失効が必要）', () => {
    expect(
      canIssueShare('published', { issuedAt: NOW.toString(), expiresAt: '2026-07-23T00:00:00.000Z' }, NOW),
    ).toBe(false);
  });
  it('published かつ失効済み/期限切れなら再発行可', () => {
    expect(
      canIssueShare(
        'published',
        { issuedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-21T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(true);
    expect(
      canIssueShare(
        'published',
        { issuedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-23T00:00:00.000Z', revokedAt: '2026-07-21T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(true);
  });
});

describe('canRevokeShare', () => {
  it('有効な共有があるときのみ true', () => {
    expect(canRevokeShare(undefined, NOW)).toBe(false);
    expect(
      canRevokeShare({ issuedAt: NOW.toString(), expiresAt: '2026-07-23T00:00:00.000Z' }, NOW),
    ).toBe(true);
    expect(
      canRevokeShare(
        { issuedAt: NOW.toString(), expiresAt: '2026-07-23T00:00:00.000Z', revokedAt: NOW.toString() },
        NOW,
      ),
    ).toBe(false);
  });
});

function kiosk(id: string, enabled = true): Kiosk {
  return { id, displayName: `端末${id}`, enabled };
}

describe('selectableTargets', () => {
  it('有効な Kiosk のみ target 候補にする', () => {
    const kiosks = [kiosk('a'), kiosk('b', false), kiosk('c')];
    expect(selectableTargets(kiosks, 'site-1')).toEqual([
      { siteId: 'site-1', kioskId: 'a' },
      { siteId: 'site-1', kioskId: 'c' },
    ]);
  });
  it('有効な Kiosk が無ければ空配列', () => {
    expect(selectableTargets([kiosk('a', false)], 'site-1')).toEqual([]);
  });
});

describe('targetLabel', () => {
  const kiosks = [kiosk('a'), kiosk('b', false)];
  it('未設定は「未設定」', () => {
    expect(targetLabel(undefined, kiosks)).toBe('未設定');
  });
  it('現存する Kiosk は表示名', () => {
    expect(targetLabel({ siteId: 's', kioskId: 'a' }, kiosks)).toBe('端末a');
  });
  it('無効化済みでも一覧に在れば表示名（除外されるのは selectableTargets 側）', () => {
    expect(targetLabel({ siteId: 's', kioskId: 'b' }, kiosks)).toBe('端末b');
  });
  it('一覧に無い（削除済み等）id はそのまま表示', () => {
    expect(targetLabel({ siteId: 's', kioskId: 'ghost' }, kiosks)).toBe('ghost');
  });
});

describe('canShowRollback', () => {
  it('履歴 0 件は false', () => {
    expect(canShowRollback(0)).toBe(false);
  });
  it('履歴 1 件以上は true', () => {
    expect(canShowRollback(1)).toBe(true);
  });
});
