import { describe, expect, it } from 'vitest';
import { resolveAdminReadState } from './read-state';

/**
 * 「まだ」と「だめだった」を混ぜない (#870 増分 04)。
 *
 * 分岐ごとの期待値を並べるのではなく、**満たすべき不変条件**で縛る
 * （`CLAUDE.md` 検証の作法）。とくに「失敗したのに loading を返さない」は、この関数が
 * 存在する理由そのものなので総当たりで押さえる。
 */
describe('resolveAdminReadState (#870)', () => {
  const CASES = [
    { loaded: false, failed: false },
    { loaded: false, failed: true },
    { loaded: true, failed: false },
    { loaded: true, failed: true },
  ] as const;

  it('失敗しているのに loading を返さない（終わらない待ちを作らない）', () => {
    for (const input of CASES) {
      if (!input.failed) continue;
      expect(resolveAdminReadState(input), JSON.stringify(input)).not.toBe('loading');
    }
  });

  it('載っているなら loaded（再取得の失敗で画面を空にしない）', () => {
    for (const input of CASES) {
      if (!input.loaded) continue;
      expect(resolveAdminReadState(input), JSON.stringify(input)).toBe('loaded');
    }
  });

  /*
   * 下界。上の 2 本は「常に loaded を返す」実装でも通る（前者は loading でなければよく、
   * 後者は loaded を求めるだけなので）。**まだ何も起きていない状態が loading であること**を
   * 併せて縛らないと、失敗も未取得も全部 loaded になる実装が生き残る。
   */
  it('まだ読めておらず失敗もしていないなら loading', () => {
    expect(resolveAdminReadState({ loaded: false, failed: false })).toBe('loading');
  });

  it('読めていない失敗は failed', () => {
    expect(resolveAdminReadState({ loaded: false, failed: true })).toBe('failed');
  });
});
