/**
 * 🔴 **隔離を自分で外したときに落ちることを、親から測るための probe (#1136)。**
 *
 * `tests/setup/temp-isolation.ts` の `afterAll` は `os.tmpdir() !== fileRoot` を見て
 * 大声で落とす（走査で綴りを追うのをやめた代わりの機構）。**その機構自身の下界**として、
 * わざと `TMPDIR` を書き換えたまま戻さないファイルを用意し、
 * `tests/config/temp-cleanup-guard.test.ts` が子 vitest として起動して
 * **実際に落ちること**を確かめる。
 *
 * 併せて、`ISOLATION_STALE_ROOT` が指すディレクトリを**掃き出しが消したか**も測れる
 * （setup の起動時に `sweepStaleRoots` が走る。呼び出しを外す退行の下界）。
 *
 * どちらの env も無ければ何もしないので、通常の unit レーンでは無害。
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('隔離を外す probe（親が結果を読む）', () => {
  it('TMPDIR を書き換えて戻さない', () => {
    if (process.env.ISOLATION_ESCAPE_PROBE === '1') {
      process.env.TMPDIR = homedir();
    }
    expect(true).toBe(true);
  });
});
