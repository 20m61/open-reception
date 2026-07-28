/**
 * 無操作リセットの上限解決 (#476 / #125 / #324)。
 *
 * 背景: E2E の `?inactivityMs=` は **全状態**に一律で効くため、connected の自動復帰だけを
 * 検証したいテストでも、そこへ至る 6 ステップの操作すべてが同じ短い上限に晒されていた。
 * 上限 600ms のとき警告オーバーレイは 500ms の無操作で出る（`limit - warnMs`）ので、
 * 1 ステップでもアニメーション待ち等で 500ms を超えると、オーバーレイが click を
 * 横取りしてテストが落ちる（負荷次第で落ちる構造的な競合＝フレーク）。
 *
 * アプリは既に connected とそれ以外で既定値を分けている。上書きにも同じ粒度を与えて、
 * 「フロー中は本番既定・connected だけ短縮」を表現できるようにする。
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTED_INACTIVITY_RESET_MS,
  INACTIVITY_RESET_MS,
  resolveInactivityLimitMs,
} from './inactivity';

describe('resolveInactivityLimitMs — 既定', () => {
  it('選択・入力画面は INACTIVITY_RESET_MS', () => {
    expect(resolveInactivityLimitMs({ search: '', state: 'selectingPurpose' })).toBe(
      INACTIVITY_RESET_MS,
    );
  });

  it('connected は長めの CONNECTED_INACTIVITY_RESET_MS', () => {
    expect(resolveInactivityLimitMs({ search: '', state: 'connected' })).toBe(
      CONNECTED_INACTIVITY_RESET_MS,
    );
  });
});

describe('resolveInactivityLimitMs — ?inactivityMs=（全状態に効く既存の流儀）', () => {
  it('connected 以外にも効く', () => {
    expect(resolveInactivityLimitMs({ search: '?inactivityMs=600', state: 'selectingPurpose' })).toBe(
      600,
    );
  });

  it('connected にも効く', () => {
    expect(resolveInactivityLimitMs({ search: '?inactivityMs=600', state: 'connected' })).toBe(600);
  });
});

describe('resolveInactivityLimitMs — ?inactivityMs.<state>=（状態限定）', () => {
  it('指定した状態だけを短縮する', () => {
    expect(resolveInactivityLimitMs({ search: '?inactivityMs.connected=600', state: 'connected' })).toBe(
      600,
    );
    expect(
      resolveInactivityLimitMs({
        search: '?inactivityMs.inputVisitorInfo=600',
        state: 'inputVisitorInfo',
      }),
    ).toBe(600);
  });

  it('他の状態は本番既定のまま（そこへ至る操作をオーバーレイに横取りさせない）', () => {
    for (const state of ['selectingPurpose', 'selectingTarget', 'inputVisitorInfo', 'confirming'] as const) {
      expect(
        resolveInactivityLimitMs({ search: '?inactivityMs.connected=600', state }),
        state,
      ).toBe(INACTIVITY_RESET_MS);
    }
    expect(resolveInactivityLimitMs({ search: '?inactivityMs.connected=600', state: 'connected' })).toBe(
      600,
    );
  });

  it('一律の ?inactivityMs= より優先する（より具体的な指定が勝つ）', () => {
    expect(
      resolveInactivityLimitMs({
        search: '?inactivityMs=5000&inactivityMs.connected=600',
        state: 'connected',
      }),
    ).toBe(600);
  });

  it('指定の無い状態では一律の ?inactivityMs= が残る', () => {
    expect(
      resolveInactivityLimitMs({
        search: '?inactivityMs=5000&inactivityMs.connected=600',
        state: 'selectingPurpose',
      }),
    ).toBe(5000);
  });
});

describe('resolveInactivityLimitMs — 不正値は既定へフォールバック', () => {
  it('0・負値・非数・空は無視する', () => {
    for (const raw of ['0', '-1', 'abc', '']) {
      expect(
        resolveInactivityLimitMs({ search: `?inactivityMs=${raw}`, state: 'selectingPurpose' }),
        raw,
      ).toBe(INACTIVITY_RESET_MS);
      expect(
        resolveInactivityLimitMs({ search: `?inactivityMs.connected=${raw}`, state: 'connected' }),
        raw,
      ).toBe(CONNECTED_INACTIVITY_RESET_MS);
    }
  });
});
