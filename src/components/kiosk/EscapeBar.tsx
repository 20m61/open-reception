'use client';

import { useEffect, useRef, useState } from 'react';

import { isContentOccluded, type SiblingBox } from '@/domain/kiosk/escape-bar-occlusion';
import { htmlLangFor, makeT, type Locale, type MessageKey } from '@/lib/i18n';
import { persistentRegionProps, type PersistentElementTestId } from './persistent-regions';

/**
 * 常設逃げ道バー (issue #121 / #325 / #361 AC2)。
 *
 * 受付（`KioskFlow`）と QR 受付（`CheckinFlow`）が**同じコンポーネント**を使う。かつて QR 側は
 * 各画面が後退ボタンを手書きしており、後退の位置と語彙が受付と違っていた。バーを 2 つ実装すると
 * 片方だけ直る（このリポジトリが繰り返し踏んできた形）ので、構造そのものを 1 つにする。
 *
 * **出す項目を決めるのはここではない。** 受付は `escapeHatchesFor`、QR は `checkinEscapesFor`
 * が契約から導出した結果を渡す。ここは描画だけを持つ（項目ゼロなら何も描かない）。
 *
 * 常設バーなので訳が抜けると来訪者が受付中ずっと日本語のボタンを見続ける (#327)。文言は
 * 必ず i18n キーで受け取り、解決はここで行う。
 */
export type EscapeBarItem = {
  /** React key と `onSelect` の識別子。受付は `ReceptionAction`、QR は `CheckinEvent`。 */
  id: string;
  labelKey: MessageKey;
  variant: 'ghost' | 'secondary';
  testId: string;
};

/**
 * バーが内容を覆っているかを**実測**し続ける (#816)。
 *
 * 観測すべき事象は 3 つあり、どれか 1 つでも欠けると古い値が残る:
 *
 * - **スクロール** … バーが sticky で持ち上がる/降りるのはこれ
 * - **バー自身のリサイズ** … `flex-wrap` で段数が変わると自然位置が動く
 * - **本文のリサイズ** … `KioskFlow` が #788 で踏んだ形。担当者を検索で絞ると一覧が縮んで
 *   ページが overflow しなくなるが、**scroll も resize も発火しない**（`scrollY` は 0 のまま）
 *
 * 判定そのものは純関数 `isContentOccluded` が持ち、ここは DOM から数を読むだけにする。
 */
function useOccludedByBar(barRef: React.RefObject<HTMLElement | null>, deps: unknown): boolean {
  const [occluded, setOccluded] = useState(false);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') {
      setOccluded(false);
      return;
    }
    const measure = () => {
      const siblings: SiblingBox[] = [];
      for (let el = bar.previousElementSibling; el; el = el.previousElementSibling) {
        const rect = el.getBoundingClientRect();
        siblings.push({
          position: window.getComputedStyle(el).position,
          bottom: rect.bottom,
          height: rect.height,
          width: rect.width,
        });
      }
      setOccluded(isContentOccluded(bar.getBoundingClientRect().top, siblings));
    };
    measure();
    const ro = new ResizeObserver(measure);
    /*
     * ⚠️ **この観測はテストで縛れていない。** 変異検証で外してみたが、到達可能な状態では
     * 下の `document.body` の観測と区別が付かず生存した（バーが再ラップするような変化は
     * 本文の高さも動かすため）。バーだけが変わって本文が変わらない配置が将来出たときの
     * 保険として残すが、**縛れていないことをここに明記しておく**（縛れているつもりで
     * 依存されると、落ちたときに誰も気づかない）。
     */
    ro.observe(bar);
    // 本文が縮んだだけでバーの位置が動く経路（#788 と同型）を取りこぼさない。
    // こちらは e2e（検索で一覧を縮める）で縛ってある。
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
    // deps（＝出している項目）が変わるとバーの段数と自然位置が変わるので測り直す。
  }, [barRef, deps]);

  return occluded;
}

export function EscapeBar({
  items,
  onSelect,
  regionTestId,
  locale,
  barRef,
}: {
  items: ReadonlyArray<EscapeBarItem>;
  onSelect: (id: string) => void;
  /** 登録簿の常設要素 ID。領域属性は登録簿からしか供給されない（描画側で手書きしない）。 */
  regionTestId: PersistentElementTestId;
  locale: Locale;
  barRef?: React.RefObject<HTMLElement | null>;
}) {
  /*
   * 測定用の内部 ref。外から渡された `barRef`（`KioskFlow` がチャット FAB の持ち上げ量に使う）
   * とは別に持ち、描画時に両方へ流す。**フックは早期 return より前に置く**（項目ゼロで
   * null を返す枝があるため、順番を入れ替えるとフックの規則を破る）。
   */
  /*
   * 外から ref が来ていればそれを**そのまま** `ref` に渡し、測定側は同じオブジェクトの
   * `.current` を**読むだけ**にする。
   *
   * 🔴 **ref を 2 つ持って手で流し込まない。** 呼び出し側の ref へ代入するコードは
   * `react-hooks/immutability`（React Compiler）が error にする ——「render 後にローカルを
   * 変更している」「この値は変更できない」。読むだけなら衝突しないし、そもそも
   * ref オブジェクトは 1 つで足りる。
   */
  const fallbackRef = useRef<HTMLElement | null>(null);
  const measuredRef = barRef ?? fallbackRef;
  const occluded = useOccludedByBar(measuredRef, items.length);

  if (items.length === 0) return null;
  const tr = makeT(locale);
  return (
    <nav
      ref={measuredRef}
      className="kiosk-escape-bar"
      {...persistentRegionProps(regionTestId)}
      aria-label={tr('reception.escapeBarLabel')}
      lang={htmlLangFor(locale)}
    >
      {/*
        バーの下に内容が隠れているときだけ出す「まだ続きがある」の提示 (#816)。
        バーは不透明なので、隠れた部分は「カードが途中で切れている」ようにしか見えず、
        **スクロールできると分からない**（1024x768 の相手選択で最下段の群カードが 76px、
        「N名」バッジは高さ 38px の全部が隠れていた。実測）。

        `aria-hidden`: 支援技術の利用者は DOM を順に辿るので隠れた内容へ到達できており、
        この提示は**視覚的な発見可能性だけ**を補う。スクロールのたびに `role="status"` で
        読み上げると、解決しない問題を繰り返し告げることになる。

        絶対配置なのでバー自身の寸法を変えない（`ResizeObserver` の観測ループにならない）。
      */}
      {occluded ? (
        <span className="kiosk-escape-bar__more" data-testid="escape-bar-scroll-more" aria-hidden="true">
          {tr('reception.scrollForMore')}
        </span>
      ) : null}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`btn btn--${item.variant}`}
          data-testid={item.testId}
          onClick={() => onSelect(item.id)}
        >
          {tr(item.labelKey)}
        </button>
      ))}
    </nav>
  );
}
