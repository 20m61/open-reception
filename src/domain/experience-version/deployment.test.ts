import { describe, expect, it } from 'vitest';
import {
  classifyDeployment,
  isStale,
  nextApplicableRevision,
  summarizeRollout,
} from './deployment';
import type { KioskConfigDeployment } from './types';
import { asSiteId } from '@/domain/tenant/types';

const SITE = asSiteId('site-1');

function deployment(over: Partial<KioskConfigDeployment> = {}): KioskConfigDeployment {
  return {
    kioskId: 'kiosk-1',
    siteId: SITE,
    desiredRevision: 2,
    desiredConfigHash: 'sha256:bbb',
    ...over,
  };
}

describe('classifyDeployment', () => {
  it('desired と loaded が版・指紋ともに一致すれば applied', () => {
    expect(
      classifyDeployment(deployment({ loadedRevision: 2, loadedConfigHash: 'sha256:bbb' })),
    ).toBe('applied');
  });

  it('まだ何も読み込んでいなければ pending', () => {
    expect(classifyDeployment(deployment())).toBe('pending');
  });

  it('古い版で動いていれば stale（last-known-good で運用継続中）', () => {
    expect(
      classifyDeployment(deployment({ loadedRevision: 1, loadedConfigHash: 'sha256:aaa' })),
    ).toBe('stale');
  });

  it('desired の読込に失敗していれば failed', () => {
    expect(
      classifyDeployment(
        deployment({
          loadedRevision: 1,
          loadedConfigHash: 'sha256:aaa',
          errorCode: 'asset_load_failed',
          errorRevision: 2,
        }),
      ),
    ).toBe('failed');
  });

  it('過去の版で起きた失敗は、いまの desired を failed にしない', () => {
    expect(
      classifyDeployment(
        deployment({
          loadedRevision: 2,
          loadedConfigHash: 'sha256:bbb',
          errorCode: 'asset_load_failed',
          errorRevision: 1,
        }),
      ),
    ).toBe('applied');
  });

  it('版が一致しても指紋が違えば stale（端末は再取得が要る）', () => {
    expect(
      classifyDeployment(deployment({ loadedRevision: 2, loadedConfigHash: 'sha256:other' })),
    ).toBe('stale');
  });

  it('端末が desired より新しい版を読み込んでいる場合も stale として扱う（不整合の可視化）', () => {
    expect(
      classifyDeployment(deployment({ loadedRevision: 5, loadedConfigHash: 'sha256:new' })),
    ).toBe('stale');
  });
});

describe('isStale', () => {
  it('公開中の版より古い版で動いている端末を検出する', () => {
    expect(isStale({ publishedRevision: 3, loadedRevision: 2 })).toBe(true);
    expect(isStale({ publishedRevision: 3, loadedRevision: 3 })).toBe(false);
    expect(isStale({ publishedRevision: 3, loadedRevision: undefined })).toBe(true);
  });
});

describe('summarizeRollout', () => {
  it('端末ごとの状態を数え、全台 applied のときだけ complete', () => {
    const summary = summarizeRollout([
      deployment({ kioskId: 'k1', loadedRevision: 2, loadedConfigHash: 'sha256:bbb' }),
      deployment({ kioskId: 'k2', loadedRevision: 1, loadedConfigHash: 'sha256:aaa' }),
      deployment({ kioskId: 'k3' }),
      deployment({
        kioskId: 'k4',
        loadedRevision: 1,
        loadedConfigHash: 'sha256:aaa',
        errorCode: 'schema_invalid',
        errorRevision: 2,
      }),
    ]);

    expect(summary).toEqual({
      total: 4,
      applied: 1,
      pending: 1,
      stale: 1,
      failed: 1,
      complete: false,
    });
  });

  it('全台反映済みなら complete', () => {
    const summary = summarizeRollout([
      deployment({ kioskId: 'k1', loadedRevision: 2, loadedConfigHash: 'sha256:bbb' }),
      deployment({ kioskId: 'k2', loadedRevision: 2, loadedConfigHash: 'sha256:bbb' }),
    ]);

    expect(summary).toMatchObject({ total: 2, applied: 2, complete: true });
  });

  it('対象端末が 0 台なら complete にしない（公開できたと誤認させない）', () => {
    expect(summarizeRollout([])).toEqual({
      total: 0,
      applied: 0,
      pending: 0,
      stale: 0,
      failed: 0,
      complete: false,
    });
  });
});

describe('nextApplicableRevision', () => {
  it('受付が進行中なら、いま読み込んでいる版を維持する（来訪者を中断しない）', () => {
    expect(
      nextApplicableRevision({ loadedRevision: 1, desiredRevision: 2, sessionActive: true }),
    ).toBe(1);
  });

  it('待機中なら desired へ切り替える', () => {
    expect(
      nextApplicableRevision({ loadedRevision: 1, desiredRevision: 2, sessionActive: false }),
    ).toBe(2);
  });

  it('未読込の端末は受付中でも desired を採用する（維持すべき版が無い）', () => {
    expect(
      nextApplicableRevision({ loadedRevision: undefined, desiredRevision: 2, sessionActive: true }),
    ).toBe(2);
  });
});
