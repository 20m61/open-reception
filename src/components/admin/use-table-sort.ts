'use client';

import { useCallback, useMemo } from 'react';
import { useQueryParams } from './use-query-params';
import type { SortState } from './list-io';

/**
 * 一覧の並べ替え状態を **URL クエリ**に持つ (#909 / 課題 18)。
 *
 * 既存のフィルタ（#94）と同じ流儀 —— 戻る/進む・リロード・共有で復元される。
 * 「この並びで見てほしい」を URL で渡せることは、運用者同士のやり取りで実際に効く。
 *
 * 並べ替えを変えたら**ページを 1 に戻す**。順序が変われば 2 ページ目の中身は
 * まったく別のものになるので、そこへ留まる意味が無い。
 */
export function useTableSort(paramPrefix = 'sort'): {
  sort: SortState | undefined;
  setSort: (next: SortState | undefined) => void;
} {
  const { get, setMany } = useQueryParams();
  const key = get(paramPrefix);
  const direction = get(`${paramPrefix}Dir`);

  const sort = useMemo<SortState | undefined>(() => {
    if (!key) return undefined;
    // 未知の向きは昇順として読む（壊れた URL でも一覧を出す）。
    return { key, direction: direction === 'desc' ? 'desc' : 'asc' };
  }, [key, direction]);

  const setSort = useCallback(
    (next: SortState | undefined) => {
      setMany({
        [paramPrefix]: next?.key ?? '',
        [`${paramPrefix}Dir`]: next?.direction ?? '',
        page: '',
      });
    },
    [paramPrefix, setMany],
  );

  return { sort, setSort };
}
