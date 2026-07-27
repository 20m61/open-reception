/**
 * 構成の再取得と適用タイミングの単体テスト (issue #420 increment 6)。
 *
 * AC「受付中の来訪者が公開操作によって中断されない」を端末側で成立させる判定。
 * 「取得はいつでもしてよいが、**適用は受付が終わってから**」を固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_SYNC_INTERVAL_MS,
  resolveConfigurationSyncInterval,
  shouldApplyConfiguration,
} from './configuration-sync';

const v = (revision?: number, contentHash?: string) => ({ revision, contentHash });

describe('shouldApplyConfiguration', () => {
  it('まだ何も読み込んでいない端末は、受付中でも適用する', () => {
    // 未読込のまま受付を続けさせると、既定値（担当者ゼロ・既定文言）のまま接客することになる。
    // `nextApplicableRevision` が「維持すべき版が無い端末は desired を採用する」としているのと同じ規則。
    expect(shouldApplyConfiguration({ sessionActive: true, incoming: v(3, 'sha256:a') })).toBe(true);
    expect(shouldApplyConfiguration({ sessionActive: false, incoming: v(3, 'sha256:a') })).toBe(
      true,
    );
  });

  it('受付が進行中なら新しい版を適用しない（画面が途中で入れ替わらない）', () => {
    expect(
      shouldApplyConfiguration({
        sessionActive: true,
        current: v(3, 'sha256:a'),
        incoming: v(4, 'sha256:b'),
      }),
    ).toBe(false);
  });

  it('待機中（idle）なら新しい版を適用する', () => {
    expect(
      shouldApplyConfiguration({
        sessionActive: false,
        current: v(3, 'sha256:a'),
        incoming: v(4, 'sha256:b'),
      }),
    ).toBe(true);
  });

  it('内容が同じなら適用しない（無用な再描画を起こさない）', () => {
    expect(
      shouldApplyConfiguration({
        sessionActive: false,
        current: v(3, 'sha256:a'),
        incoming: v(3, 'sha256:a'),
      }),
    ).toBe(false);
  });

  it('版番号が同じでも内容の指紋が違えば適用する（live 配信の設定変更）', () => {
    // 版管理未導入の拠点は revision 0 固定で live 配信される。指紋も無いので、
    // 「同じ revision = 同じ内容」とみなすと設定変更が永久に届かない。
    expect(
      shouldApplyConfiguration({
        sessionActive: false,
        current: v(0, undefined),
        incoming: v(0, undefined),
      }),
    ).toBe(true);
    expect(
      shouldApplyConfiguration({
        sessionActive: false,
        current: v(3, 'sha256:a'),
        incoming: v(3, 'sha256:b'),
      }),
    ).toBe(true);
  });

  it('古い版へ戻す指示（ロールバック）も待機中なら適用する', () => {
    expect(
      shouldApplyConfiguration({
        sessionActive: false,
        current: v(4, 'sha256:b'),
        incoming: v(3, 'sha256:a'),
      }),
    ).toBe(true);
  });
});

describe('resolveConfigurationSyncInterval', () => {
  it('既定は CONFIGURATION_SYNC_INTERVAL_MS', () => {
    expect(resolveConfigurationSyncInterval('')).toBe(CONFIGURATION_SYNC_INTERVAL_MS);
    expect(resolveConfigurationSyncInterval('?inactivityMs=500')).toBe(
      CONFIGURATION_SYNC_INTERVAL_MS,
    );
  });

  it('?configSyncMs= で短縮できる（E2E 用。既存のタイマー上書きと同じ流儀）', () => {
    expect(resolveConfigurationSyncInterval('?configSyncMs=800')).toBe(800);
  });

  it('0・負数・非数は既定へ倒す（誤指定でポーリングを暴走させない）', () => {
    for (const search of ['?configSyncMs=0', '?configSyncMs=-1', '?configSyncMs=abc']) {
      expect(resolveConfigurationSyncInterval(search)).toBe(CONFIGURATION_SYNC_INTERVAL_MS);
    }
  });

  it('下限を下回る指定は下限へ丸める（端末とサーバを叩き続けない）', () => {
    expect(resolveConfigurationSyncInterval('?configSyncMs=1')).toBe(100);
  });
});
