/**
 * jti 失効ストアの単体テスト (issue #264 対応案 2)。memory バックエンドで register → state →
 * revoke の遷移と fail-closed（記録なし = unknown）を検証する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerElevationJti,
  revokeElevationJti,
  elevationJtiState,
  __resetElevationJtis,
} from './elevation-jti-store';

const NOW = 1_000_000_000_000;

beforeEach(async () => {
  await __resetElevationJtis();
});

describe('elevation jti store (#264)', () => {
  it('登録済み・期限内・未失効の jti は active', async () => {
    await registerElevationJti({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW + 60_000 });
    expect(await elevationJtiState('j1', NOW)).toBe('active');
  });

  it('未登録の jti は unknown（fail-closed で無効扱い）', async () => {
    expect(await elevationJtiState('nope', NOW)).toBe('unknown');
  });

  it('revoke 後は revoked（期限前の取り消し）', async () => {
    await registerElevationJti({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW + 60_000 });
    expect(await revokeElevationJti('j1', NOW)).toBe(true);
    expect(await elevationJtiState('j1', NOW)).toBe('revoked');
  });

  it('未登録 jti の revoke は false（何もしない）', async () => {
    expect(await revokeElevationJti('nope', NOW)).toBe(false);
  });

  it('期限切れは expired', async () => {
    await registerElevationJti({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW - 1 });
    expect(await elevationJtiState('j1', NOW)).toBe('expired');
  });

  it('revoke は冪等（二重 end でもエラーにしない）', async () => {
    await registerElevationJti({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW + 60_000 });
    expect(await revokeElevationJti('j1', NOW)).toBe(true);
    expect(await revokeElevationJti('j1', NOW + 1)).toBe(true);
    expect(await elevationJtiState('j1', NOW)).toBe('revoked');
  });
});
