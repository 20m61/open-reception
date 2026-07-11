import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/proxy', () => ({ PATHNAME_HEADER: 'x-pathname' }));

import { resolveKioskTitle } from './layout';

describe('resolveKioskTitle: 受付端末のタブタイトル解決 (#331)', () => {
  it.each([
    ['/kiosk', '受付'],
    ['/kiosk/checkout', '退館受付'],
    ['/kiosk/enroll', '端末登録'],
    ['/kiosk/signage', '待機サイネージ'],
    ['/kiosk/checkout/summary', '退館受付'], // 配下パスも最長一致
  ])('%s は %s に解決される', (pathname, expected) => {
    expect(resolveKioskTitle(pathname)).toBe(expected);
  });

  it('/kiosk 配下の未知パスは "/kiosk" 自体に前方一致し「受付」になる', () => {
    expect(resolveKioskTitle('/kiosk/does-not-exist')).toBe('受付');
  });

  it('/kiosk 配下ですらない未知のパスも既定文言「受付」にフォールバックする', () => {
    expect(resolveKioskTitle('')).toBe('受付');
    expect(resolveKioskTitle('/other')).toBe('受付');
  });
});
