/**
 * 来訪者が自分で呼び出し中を抜けたとき、サーバへ伝えるか (#743)。
 *
 * `/give-up`（#743 AC3）が拾うのは**ポーリング上限に達した諦め**だけだった。
 * 逃げ道バーの「最初に戻る」やチャットの「キャンセル」で自分から抜けた場合、端末は
 * 待機画面へ戻るのに**サーバの受付は `calling` のまま**残り、取次は hop 上限まで進む。
 * しかもポーリングは抜けた時点で止まる（#652）ので `/give-up` も呼ばれない ──
 * **自分から抜けるほうが、放っておくより取次が長く走る**。
 */
import { describe, expect, it } from 'vitest';
import type { ReceptionState } from './state';
import { isVisitorExit, shouldCancelOnServer } from './leave-calling';

describe('shouldCancelOnServer (#743)', () => {
  it.each(['RESET', 'CANCEL'] as const)('呼び出し中の %s は伝える', (event) => {
    expect(shouldCancelOnServer('calling', event, 'rec-1')).toBe(true);
  });

  /**
   * 🔴 **`calling` のときだけ。** 他の状態では取次が走っていないので意味が無く、
   * 既に終端した受付（担当者が応答した直後など）を蒸し返す余地を作る。
   */
  it.each([
    'idle',
    'selectingPurpose',
    'selectingTarget',
    'inputVisitorInfo',
    'confirming',
    'connected',
    'completed',
    'failed',
    'timeout',
    'cancelled',
    'fallback',
  ] as ReceptionState[])('🔴 %s では伝えない', (state) => {
    expect(shouldCancelOnServer(state, 'RESET', 'rec-1')).toBe(false);
  });

  it.each([undefined, ''])('受付 id が %p なら伝えない（相手が居ない）', (id) => {
    expect(shouldCancelOnServer('calling', 'RESET', id)).toBe(false);
  });
});

describe('isVisitorExit (#743)', () => {
  it.each(['RESET', 'CANCEL'])('%s は来訪者がやめる操作', (event) => {
    expect(isVisitorExit(event)).toBe(true);
  });

  /**
   * 🔴 **`BACK` を含めない。** 1 ステップ戻るのは受付をやめることではない
   * （そもそも `calling` からの `BACK` は状態機械が弾く）。含めると、来訪者が
   * 前の画面へ戻ろうとしただけで受付が消える。
   */
  it.each(['BACK', 'CONFIRM', 'CALL_CONNECTED', 'SELECT_TARGET', ''])(
    '🔴 %p はやめる操作ではない',
    (event) => {
      expect(isVisitorExit(event)).toBe(false);
    },
  );
});
