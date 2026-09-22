/**
 * 試行予算の検出信号（#1021 AC4 / レビュー M4）。
 *
 * 🔴 **これは変異検証で生存した穴である。** 信号そのものは足したのに、
 * **出ていることを誰も縛っていなかった**ので、記録を落とす変異とラッチを外す変異が
 * どちらも素通りした。
 *
 * ## 縛る不変条件
 *
 * > **閉じたことは記録される**（さもないと、来訪者に「担当者へお声がけください」と
 * > 言われた担当者が**なぜ閉じたのかを知る手段を持たない**）。
 * > かつ **未認証経路から出力量を制御できない**（ラッチ）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportAttemptBudgetExceeded,
  reportAttemptStoreUnavailable,
  __resetAttemptReports,
} from './attempt-report';

beforeEach(() => {
  __resetAttemptReports();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('検出信号 (#1021 AC4)', () => {
  it('🔴 予算超過を記録する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportAttemptBudgetExceeded('kiosk-authorize', 1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('kiosk-authorize');
  });

  it('🔴 帳簿が読めないことを記録する', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportAttemptStoreUnavailable('other-scope', 1000);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('other-scope');
  });

  /**
   * 🔴 **本体（ラッチ）。** 未認証経路から呼ばれるので、毎回出すと
   * **出力量を攻撃者が制御できる**（ログ課金と、他の信号が埋まることの両方）。
   */
  it('🔴 同じ経路は窓の中で 1 度だけ出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 50; i += 1) reportAttemptBudgetExceeded('kiosk-authorize', 1000 + i);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /** 🔴 下界: 窓が明ければまた出す（1 度出したら永久に黙る、ではない）。 */
  it('🔴 窓が明ければまた出す（永久に黙らない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportAttemptBudgetExceeded('kiosk-authorize', 1000);
    reportAttemptBudgetExceeded('kiosk-authorize', 1000 + 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  /** 🔴 経路ごとに独立してラッチする（kiosk の信号が admin を黙らせない）。 */
  it('🔴 経路ごとに独立してラッチする', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportAttemptBudgetExceeded('kiosk-authorize', 1000);
    reportAttemptBudgetExceeded('other-scope', 1000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  /** 🔴 種別ごとにも独立（超過とストア障害が互いを黙らせない）。 */
  it('🔴 超過とストア障害は互いを黙らせない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportAttemptBudgetExceeded('kiosk-authorize', 1000);
    reportAttemptStoreUnavailable('kiosk-authorize', 1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **値を残さない。** 未認証経路の信号なので、PIN / パスワード / IP を載せない
   * （`rules/pii-secret-minimization.md`）。
   */
  it('🔴 信号に値も発信元も載せない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportAttemptBudgetExceeded('kiosk-authorize', 1000);
    reportAttemptStoreUnavailable('other-scope', 1000);
    const all = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join('\n');
    expect(all).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // IP
    expect(all).not.toMatch(/ip:/);
    expect(all).not.toMatch(/PIN|password|pbkdf2/i);
  });
});
