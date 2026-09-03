import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TableBodyState } from './primitives';

/**
 * platform の表で「読み込み中 / 失敗 / 0 件」を描き分ける (#896 / 課題 06)。
 *
 * それまで `TenantList` 等は `(data?.tenants ?? []).map(...)` で `<tbody>` を描いており、
 * **`data` が `null`（読み込み中）でも空配列（0 件）でも `<tbody>` が空になるだけ**だった。
 * さらに失敗しても `data` は `null` のままなので、`read-state.ts` が警告している
 * 「**失敗が『読み込み中』に化ける**」がそのまま起きていた。
 *
 * ここで縛るのは分岐ごとの見た目ではなく**不変条件**:
 *
 *   - 3 つの状態は**互いに区別できる**（同じ描画にならない）
 *   - **下界**: 行が在るときは何も足さない（常に何か出す実装を落とす）
 */

function render(props: Parameters<typeof TableBodyState>[0]): string {
  return renderToStaticMarkup(<TableBodyState {...props} />);
}

const BASE = { columns: 4, emptyMessage: 'テナントはまだありません。', testId: 'tenant-list' } as const;

describe('TableBodyState', () => {
  it('🔴 下界: 行が在るなら何も足さない', () => {
    // 「常に何か出す」実装だと、一覧の先頭か末尾に余計な行が居座る。
    expect(render({ ...BASE, loaded: true, failed: false, rowCount: 3 })).toBe('');
  });

  it('読み込み中は「読み込み中」と分かる（0 件と同じ描画にしない）', () => {
    const loading = render({ ...BASE, loaded: false, failed: false, rowCount: 0 });
    expect(loading).not.toBe('');
    expect(loading).toContain('tenant-list-loading');
  });

  it('0 件は 0 件と分かる（読み込み中と同じ描画にしない）', () => {
    const empty = render({ ...BASE, loaded: true, failed: false, rowCount: 0 });
    expect(empty).toContain('tenant-list-empty');
    expect(empty).toContain('テナントはまだありません。');
  });

  it('失敗は「読み込み中」に化けない', () => {
    /*
     * 🔴 これが `read-state.ts` の言う欠陥そのもの。`data` は失敗しても `null` のままなので、
     * `loaded` だけを見ると失敗が永遠の「読み込み中」になる。
     */
    const failed = render({ ...BASE, loaded: false, failed: true, rowCount: 0 });
    expect(failed).toContain('tenant-list-failed');
    expect(failed).not.toContain('tenant-list-loading');
  });

  it('3 つの状態は互いに区別できる', () => {
    const loading = render({ ...BASE, loaded: false, failed: false, rowCount: 0 });
    const failed = render({ ...BASE, loaded: false, failed: true, rowCount: 0 });
    const empty = render({ ...BASE, loaded: true, failed: false, rowCount: 0 });
    expect(new Set([loading, failed, empty]).size).toBe(3);
  });

  /*
   * 表の中に入るので、`<tr>` / `<td colspan>` の形でないと行が崩れる。
   */
  it('表の行として成立する（colspan で全列を覆う）', () => {
    const empty = render({ ...BASE, loaded: true, failed: false, rowCount: 0 });
    expect(empty.startsWith('<tr')).toBe(true);
    /*
     * `renderToStaticMarkup` は `colSpan="4"` と camelCase のまま出す（HTML の属性名は
     * 大小を区別しないのでブラウザでは同じ）。**綴りではなく「全列を覆うこと」を縛る。**
     */
    expect(empty.toLowerCase()).toContain('colspan="4"');
  });
});
