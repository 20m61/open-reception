import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 予告時刻の記録を宣言順ではなく `useLayoutEffect` で担保する (#837.2)。
 *
 * 記録 effect が passive のままだと、ゲート effect より後に宣言した瞬間に
 * 同一コミットのゲートが `noticeShownAtRef === null` を読み、CALL_TIMEOUT が
 * 二度と dispatch されない（呼び出し中で固着。#826 と同型）。
 *
 * layout は passive より必ず先に走るので、ファイル内の並びを契約にしない。
 *
 * 正本は `use-calling-notice-hold.ts`（KioskFlow / CheckinFlow が共有する）。
 */
const SRC = readFileSync(join(import.meta.dirname, 'use-calling-notice-hold.ts'), 'utf8');

describe('予告時刻の記録は useLayoutEffect (#837.2)', () => {
  it('noticeShownAtRef への初回書き込みは、直近のフックが useLayoutEffect である', () => {
    const idx = SRC.indexOf('noticeShownAtRef.current = Date.now()');
    expect(idx, '予告時刻を Date.now() で記録する行が無い').toBeGreaterThan(0);
    const before = SRC.slice(0, idx);
    const layout = before.lastIndexOf('useLayoutEffect(');
    const effect = before.lastIndexOf('useEffect(');
    expect(
      layout,
      '記録が useLayoutEffect でない。ゲートより後に宣言すると同一コミットで null を読む',
    ).toBeGreaterThan(effect);
  });

  it('ゲート側は useEffect のまま（layout に上げると描画前に dispatch しうる）', () => {
    const gate = SRC.indexOf('timeoutDispatchGateMs(');
    expect(gate, 'timeoutDispatchGateMs の呼び出しが無い').toBeGreaterThan(0);
    const before = SRC.slice(0, gate);
    const layout = before.lastIndexOf('useLayoutEffect(');
    const effect = before.lastIndexOf('useEffect(');
    expect(effect, 'ゲートが useEffect でない').toBeGreaterThan(layout);
  });
});
