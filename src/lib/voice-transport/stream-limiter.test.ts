import { describe, it, expect } from 'vitest';
import { createInMemoryStreamLimiter } from './stream-limiter';

describe('createInMemoryStreamLimiter', () => {
  it('acquires up to the max concurrent streams for a kiosk', () => {
    const limiter = createInMemoryStreamLimiter();
    expect(limiter.tryAcquire('kiosk-1', 'stream-a', 2)).toBe(true);
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 2)).toBe(true);
    expect(limiter.activeCount('kiosk-1')).toBe(2);
  });

  it('rejects acquiring beyond the max concurrent streams', () => {
    const limiter = createInMemoryStreamLimiter();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1);
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 1)).toBe(false);
    expect(limiter.activeCount('kiosk-1')).toBe(1);
  });

  it('re-acquiring the same streamId is idempotent (does not double count)', () => {
    const limiter = createInMemoryStreamLimiter();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1);
    expect(limiter.tryAcquire('kiosk-1', 'stream-a', 1)).toBe(true);
    expect(limiter.activeCount('kiosk-1')).toBe(1);
  });

  it('release frees capacity for a new stream', () => {
    const limiter = createInMemoryStreamLimiter();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1);
    limiter.release('kiosk-1', 'stream-a');
    expect(limiter.activeCount('kiosk-1')).toBe(0);
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 1)).toBe(true);
  });

  it('release is idempotent — releasing an unknown or already-released stream does not throw', () => {
    const limiter = createInMemoryStreamLimiter();
    expect(() => limiter.release('kiosk-1', 'never-acquired')).not.toThrow();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1);
    limiter.release('kiosk-1', 'stream-a');
    expect(() => limiter.release('kiosk-1', 'stream-a')).not.toThrow(); // 二重 release
    expect(limiter.activeCount('kiosk-1')).toBe(0);
  });

  it('tracks each kiosk independently — one kiosk at capacity does not block another', () => {
    const limiter = createInMemoryStreamLimiter();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1);
    expect(limiter.tryAcquire('kiosk-2', 'stream-b', 1)).toBe(true);
  });

  it('drops empty kiosk entries on release so memory does not grow with idle kiosks', () => {
    const limiter = createInMemoryStreamLimiter();
    for (let i = 0; i < 200; i += 1) {
      const kioskId = `kiosk-${i}`;
      limiter.tryAcquire(kioskId, 'stream-a', 1);
      limiter.release(kioskId, 'stream-a');
    }
    expect(limiter.trackedKioskCount()).toBe(0);
  });

  it('auto-releases a slot once expiresAtMs passes, without an explicit release call', () => {
    let now = 0;
    const limiter = createInMemoryStreamLimiter(() => now);
    limiter.tryAcquire('kiosk-1', 'stream-a', 1, 100); // token TTL 相当の期限
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 1, 100)).toBe(false); // まだ枠が空かない

    now = 101; // 期限超過
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 1, 200)).toBe(true); // 自動解放されている
  });

  it('a token issued without an explicit TTL never auto-expires (must be released explicitly)', () => {
    const limiter = createInMemoryStreamLimiter();
    limiter.tryAcquire('kiosk-1', 'stream-a', 1); // expiresAtMs 未指定 = Infinity
    expect(limiter.tryAcquire('kiosk-1', 'stream-b', 1)).toBe(false);
  });
});
