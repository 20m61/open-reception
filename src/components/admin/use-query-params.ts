'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * 管理画面の一覧/検索状態を URL クエリに同期する小フック (issue #94)。
 *
 * 検索・フィルタ・ソート・ページ状態を URL に反映することで、
 *  - ブラウザの戻る/進む・リロード・共有 URL で画面状態が自然に復元される、
 *  - 業務データを過剰に global state 化しない（state の真実源は URL）、
 * を満たす（docs/admin-spa-design.md）。
 *
 * `force-dynamic` な管理ページで使う前提（useSearchParams は静的化と相性が悪いため）。
 */
export function useQueryParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** 指定キーの現在値（未設定は空文字）。 */
  const get = useCallback((key: string): string => searchParams.get(key) ?? '', [searchParams]);

  /**
   * 複数キーをまとめて更新する（空文字は当該キーを削除＝既定へ戻す）。
   * 履歴を汚さないよう replace（戻る/進むは個々の操作ではなくページ単位で復元される）。
   * scroll: false で一覧のスクロール位置を保つ。
   */
  const setMany = useCallback(
    (updates: Record<string, string>): void => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === '') params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return { get, setMany };
}
