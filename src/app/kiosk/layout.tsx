import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PATHNAME_HEADER } from '@/proxy';

/**
 * 受付端末レイアウト。
 * 半常設の kiosk 表示を前提とし、管理画面とは認可・UI を分離する (issue #24, #23)。
 * 認可 (PIN / IP / 端末認可) は後続 issue で middleware と接続する。
 */

/**
 * kiosk のタブタイトル解決 (issue #331)。admin/platform ほどルート数が多くないため、
 * ADMIN_NAV/PLATFORM_NAV のような共通 IA を介さず、ここで直接 4 ルート分を定義する。
 * root layout の title template と合わさり「受付 | open-reception」のように
 * 複数タブ（受付/退館受付/端末登録/待機サイネージ）を区別できるタイトルになる。
 */
const KIOSK_TITLE_ENTRIES: readonly { href: string; label: string }[] = [
  { href: '/kiosk', label: '受付' },
  { href: '/kiosk/checkout', label: '退館受付' },
  { href: '/kiosk/enroll', label: '端末登録' },
  { href: '/kiosk/signage', label: '待機サイネージ' },
];

/** 現在パスに最も近い（最長一致の）ルートラベルを解決する。未知のパスは既定文言。 */
export function resolveKioskTitle(pathname: string): string {
  const match = [...KIOSK_TITLE_ENTRIES]
    .sort((a, b) => b.href.length - a.href.length)
    .find((entry) => entry.href === pathname || pathname.startsWith(`${entry.href}/`));
  return match?.label ?? '受付';
}

export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  return { title: resolveKioskTitle(pathname) };
}

export default function KioskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div data-area="kiosk" style={{ minHeight: '100vh' }}>
      {children}
    </div>
  );
}
