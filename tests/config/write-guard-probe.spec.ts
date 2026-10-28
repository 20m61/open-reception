/**
 * 🔴 **隔離の外への書き込みが実行時に落ちることを、親から測るための probe (#1154)。**
 *
 * `tests/setup/write-guard.ts` は fs の書き込み API を包み、隔離の外枠・リポジトリ
 * 以外への書き込みを `temp-isolation.ts` の `afterAll` で落とす。**その機構自身の下界**として、
 * `tests/config/temp-cleanup-guard.test.ts` がこれを子 vitest として起動し、
 * **走査では捕まらない綴り**（変数で組んだパス・名前空間 import・`fs/promises`・`open`）の書き込みが
 * **実際に落ちること**を確かめる。
 *
 * - `WRITE_GUARD_PROBE_TARGET=<dir>` … その下へ複数の綴りで書く（親は隔離の外になる dir を渡す）
 * - `WRITE_GUARD_PROBE_TARGET=inside` … 自分の `os.tmpdir()` の下へ書く（負の対照。通るはず）
 *
 * env が無ければ何もしないので、通常の unit レーンでは無害。
 */
import * as fsNamespace from 'node:fs';
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('隔離の外へ書く probe（親が結果を読む）', () => {
  it('走査では捕まらない綴りで書く', async () => {
    const target = process.env.WRITE_GUARD_PROBE_TARGET;
    if (target === undefined) {
      expect(target).toBeUndefined();
      return;
    }
    const dir = target === 'inside' ? tmpdir() : target;
    writeFileSync(join(dir, 'named-import.json'), '{}');
    fsNamespace.mkdirSync(join(dir, 'namespace-dir'));
    await writeFile(join(dir, 'promises.json'), '{}');
    // 🔴 `appendFileSync` は内部で公開の `writeFileSync` を呼ぶ（再入を 1 回として数える下界）。
    fsNamespace.appendFileSync(join(dir, 'append.log'), 'x');
    // `open` 系はフラグが書き込みのときだけ見る（読むだけの open を違反にしない）。
    fsNamespace.closeSync(fsNamespace.openSync(join(dir, 'opened.txt'), 'w'));
    expect(fsNamespace.existsSync(join(dir, 'promises.json'))).toBe(true);
  });
});
