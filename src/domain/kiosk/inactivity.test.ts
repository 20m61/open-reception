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
  shouldAutoReturnFromCheckin,
  shouldResetOnInactivityForKiosk,
  TERMINAL_AUTO_RESET_MS,
} from './inactivity';
import { RECEPTION_STATES, shouldResetOnInactivity } from '../reception/state';

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

describe('QR 受付中の無操作リセット (#871)', () => {
  /*
   * QR 受付は**受付状態機械を進めない** —— `KioskFlow` は `setMode('checkin')` を呼ぶだけで
   * `ReceptionState` は `idle` のまま残る。`idle` は `INACTIVITY_RESET_STATES` に無いので、
   * 従来の `shouldResetOnInactivity(state)` だけで判定すると **QR 受付では無操作リセットが
   * 一度も発火しない**。予約者の氏名・会社・予約時刻を出したまま、ロビーの端末に無期限で
   * 残る（通常受付では #125 で解決済みの問題が、QR 経路にだけ残っていた）。
   */
  it('QR 受付が動いている間は、受付状態が idle でもリセット対象になる', () => {
    expect(shouldResetOnInactivityForKiosk({ receptionState: 'idle', qrCheckinActive: true })).toBe(
      true,
    );
  });

  it('QR 受付が動いていなければ、従来どおり受付状態だけで決まる', () => {
    // 下界: 何でも true になる実装では、この 2 本が両方通ることはない。
    expect(
      shouldResetOnInactivityForKiosk({ receptionState: 'idle', qrCheckinActive: false }),
    ).toBe(false);
    expect(
      shouldResetOnInactivityForKiosk({ receptionState: 'confirming', qrCheckinActive: false }),
    ).toBe(true);
  });

  it('通常受付の判定を壊さない（全 ReceptionState で従来関数と一致する）', () => {
    for (const state of RECEPTION_STATES) {
      expect(
        shouldResetOnInactivityForKiosk({ receptionState: state, qrCheckinActive: false }),
        state,
      ).toBe(shouldResetOnInactivity(state));
    }
  });
});

describe('QR 受付の終端状態からの自動復帰 (#871)', () => {
  /*
   * 通常受付は `completed` / `cancelled` から `AUTO_RESET_MS`（6 秒）で待機へ戻る。
   * QR 受付にはこの短い復帰が無く、無操作リセット（既定 60 秒）を待つしかなかった。
   * 「受付が完了しました」の画面が 1 分間居座ると、次の来訪者は端末が壊れていると読む。
   */
  it('completed / cancelled は自動復帰の対象', () => {
    expect(shouldAutoReturnFromCheckin('completed')).toBe(true);
    expect(shouldAutoReturnFromCheckin('cancelled')).toBe(true);
  });

  it('進行中の状態は対象にしない（読み取り中に勝手に戻さない）', () => {
    // 下界: 常に true を返す実装ではこの 1 本が落ちる。
    for (const state of ['idle', 'selectingMethod', 'scanning', 'resolving', 'confirming'] as const) {
      expect(shouldAutoReturnFromCheckin(state), state).toBe(false);
    }
  });

  it('終端の復帰時間は通常受付と同じ（フロー間で待たされ方を変えない）', () => {
    expect(TERMINAL_AUTO_RESET_MS).toBe(6000);
  });
});
