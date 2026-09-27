/**
 * 応答種別の取得まわりの**純関数**を縛る (#1137 レビュー 1 周目 MINOR 2)。
 *
 * hook 本体は `fetch` を注入していないので unit では踏めず、オラクルは e2e 1 spec と
 * `tsc` しか無かった。実測で**この 2 つの述語を潰す変異が生存した**ので、
 * **最も安い層へ落とせるものは落とす**。
 */
import { describe, expect, it } from 'vitest';
import {
  hasEnabledResponses,
  parseActions,
  type ActionMeta,
} from './use-staff-response-actions';

const meta = (enabled: boolean): ActionMeta => ({
  action: 'coming',
  staffLabel: '今行きます',
  severity: 'info',
  requiresConfirmation: false,
  enabled,
});

describe('hasEnabledResponses', () => {
  it('🔴 件数ではなく enabled を見る（全部無効なら「在る」と言わない）', () => {
    expect(hasEnabledResponses([meta(false)])).toBe(false);
    expect(hasEnabledResponses([meta(false), meta(false)])).toBe(false);
  });

  it('1 件でも有効なら真（下界）', () => {
    expect(hasEnabledResponses([meta(false), meta(true)])).toBe(true);
  });

  it('空配列は偽', () => {
    expect(hasEnabledResponses([])).toBe(false);
  });
});

describe('parseActions', () => {
  it('配列ならそのまま読む', () => {
    expect(parseActions({ actions: [meta(true)] })).toHaveLength(1);
  });

  /**
   * 🔴 **本体。** ここを素通りさせると `actions.filter` が throw し、
   * **担当者画面が丸ごと落ちる**（`StaffResponseActions` はこの値を直接 filter する）。
   */
  it.each([
    ['配列でない actions', { actions: { coming: true } }],
    ['actions が無い', { ok: true }],
    ['オブジェクトでない', 'nope'],
    ['null', null],
  ])('🔴 %s は読めないものとして null を返す（既定へ据え置く）', (_label, input) => {
    expect(parseActions(input)).toBeNull();
  });
});
