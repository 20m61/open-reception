/**
 * 端末の実死活集計の純関数テスト (issue #261)。
 *
 * 検証の柱:
 *   - deriveConnectivity: status/maintenance/lastSeenAt からの派生（#87 inc3 から移設）。
 *   - summarizeFleet: kiosk レジストリ（#18）と Device レジストリ（#87）の union 集計。
 *     どちらで登録された端末も漏れなく数え（AC1）、id 一致は Device を優先する。
 *   - 分母是正（AC4）: total は稼働可能端末（online+offline）のみ。maintenance/disabled は別掲。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ONLINE_WINDOW_MS,
  deriveConnectivity,
  summarizeFleet,
  type ConnectivityInput,
} from './device-liveness';

const NOW = new Date('2026-07-02T09:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const active = (over: Partial<ConnectivityInput> = {}): ConnectivityInput => ({
  status: 'active',
  maintenance: false,
  ...over,
});

describe('deriveConnectivity (#87 inc3 → domain へ移設)', () => {
  it('lastSeenAt が窓内なら online', () => {
    expect(deriveConnectivity(active({ lastSeenAt: iso(60_000) }), NOW)).toBe('online');
  });

  it('lastSeenAt が窓外なら offline', () => {
    expect(
      deriveConnectivity(active({ lastSeenAt: iso(DEFAULT_ONLINE_WINDOW_MS + 1) }), NOW),
    ).toBe('offline');
  });

  it('lastSeenAt 未取得（heartbeat 未着）は offline', () => {
    expect(deriveConnectivity(active(), NOW)).toBe('offline');
  });

  it('未来の lastSeenAt（時計ずれ）は offline 扱い', () => {
    expect(deriveConnectivity(active({ lastSeenAt: iso(-60_000) }), NOW)).toBe('offline');
  });

  it('revoked は heartbeat 中でも disabled', () => {
    expect(
      deriveConnectivity({ status: 'revoked', lastSeenAt: iso(1_000) }, NOW),
    ).toBe('disabled');
  });

  it('maintenance は heartbeat 中でも maintenance', () => {
    expect(
      deriveConnectivity(active({ maintenance: true, lastSeenAt: iso(1_000) }), NOW),
    ).toBe('maintenance');
  });

  it('窓はカスタマイズできる', () => {
    const d = active({ lastSeenAt: iso(10_000) });
    expect(deriveConnectivity(d, NOW, 5_000)).toBe('offline');
    expect(deriveConnectivity(d, NOW, 20_000)).toBe('online');
  });
});

describe('summarizeFleet (#261 union 集計)', () => {
  const device = (id: string, over: Partial<ConnectivityInput> = {}) => ({
    id,
    ...active(over),
  });

  it('Device / kiosk どちらで登録された端末も漏れなく数える（AC1）', () => {
    const summary = summarizeFleet(
      [device('d1', { lastSeenAt: iso(1_000) })],
      [{ id: 'k1', enabled: true }],
      NOW,
    );
    // d1 = online、k1（kiosk のみ・heartbeat 実績なし）= offline。
    expect(summary).toEqual({ total: 2, online: 1, offline: 1, maintenance: 0, disabled: 0 });
  });

  it('id 一致（kiosk↔Device の対応づけ）は Device 側を優先し二重に数えない', () => {
    const summary = summarizeFleet(
      [device('kiosk-dev', { lastSeenAt: iso(1_000) })],
      [{ id: 'kiosk-dev', enabled: true }],
      NOW,
    );
    expect(summary).toEqual({ total: 1, online: 1, offline: 0, maintenance: 0, disabled: 0 });
  });

  it('kiosk のみで失効（enabled=false）の端末は disabled として別掲する', () => {
    const summary = summarizeFleet([], [{ id: 'k-off', enabled: false }], NOW);
    expect(summary).toEqual({ total: 0, online: 0, offline: 0, maintenance: 0, disabled: 1 });
  });

  it('分母（total）は稼働可能端末のみ。maintenance/disabled は含めず別掲（AC4）', () => {
    const summary = summarizeFleet(
      [
        device('on', { lastSeenAt: iso(1_000) }),
        device('off', { lastSeenAt: iso(DEFAULT_ONLINE_WINDOW_MS + 60_000) }),
        device('mnt', { maintenance: true }),
        device('dis', { status: 'revoked' }),
      ],
      [],
      NOW,
    );
    expect(summary).toEqual({ total: 2, online: 1, offline: 1, maintenance: 1, disabled: 1 });
  });

  it('端末ゼロは全カウント 0（graceful empty）', () => {
    expect(summarizeFleet([], [], NOW)).toEqual({
      total: 0,
      online: 0,
      offline: 0,
      maintenance: 0,
      disabled: 0,
    });
  });

  it('窓の指定は deriveConnectivity と同様に効く', () => {
    const summary = summarizeFleet([device('d1', { lastSeenAt: iso(10_000) })], [], NOW, 5_000);
    expect(summary.online).toBe(0);
    expect(summary.offline).toBe(1);
  });
});
