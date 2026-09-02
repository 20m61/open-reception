'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 未保存の変更があるとき、離脱を止めて確認する (#912 / 課題 12)。
 *
 * 止める経路は 2 つある。
 *
 * 1. **ブラウザの離脱**（タブを閉じる・リロード・外部 URL）… `beforeunload`。
 *    文言はブラウザが決める（`returnValue` の内容は無視される）ので、こちらは
 *    「止める」ことだけを担う。
 * 2. **アプリ内の遷移**（サイドバーのリンク）… App Router には `router.events` が無く、
 *    `<Link prefetch>` の遷移は即座なので、**capture フェーズでクリックを横取りする**。
 *    捕まえたリンク先を保留し、確認が済んでから `router.push` する。
 *
 * 🔴 **確認に `window.confirm` を使わない。** #889 で 8 箇所を二段確認へ移したばかりで、
 * ここで戻すと同じ穴を開け直すことになる（無スタイル・翻訳不可・フォーカス管理なし）。
 * 呼び出し側が `pendingHref` を見てダイアログを出す。
 */
export function useUnsavedChangesGuard(dirty: boolean): {
  pendingHref: string | null;
  leave: () => void;
  stay: () => void;
} {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 一部のブラウザは `returnValue` の設定を必要とする（文言自体は使われない）。
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      // 修飾キー付き・中クリックは別タブで開くので、この画面は離脱しない。
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      // 同一オリジンのアプリ内遷移だけを扱う（外部リンクは `beforeunload` の担当）。
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (href === `${window.location.pathname}${window.location.search}`) return;

      e.preventDefault();
      setPendingHref(href);
    };
    // capture フェーズで拾う。`<Link>` 自身のハンドラより先に止める必要がある。
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty]);

  const leave = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    if (href) router.push(href);
  }, [pendingHref, router]);

  const stay = useCallback(() => setPendingHref(null), []);

  return { pendingHref, leave, stay };
}
