import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable, type Column } from './DataTable';

/**
 * `DataTable` が「読み込み中 / 失敗 / 0 件」を描き分ける (#896 / 課題 06)。
 *
 * それまで `DataTable` は `rows.length === 0` で `EmptyState` を出すだけで、
 * **「まだ読めていない」と「0 件だった」を区別できなかった**。取得できていないのに
 * 「登録された部署はありません。」と**断定**するのは、`read-state.ts` と #870 の
 * `AdminReadGate` が繰り返し潰してきた型そのものである。
 *
 * 状態の決め方は `resolveAdminReadState` を使う —— 画面ごとに別の判断を書かせない。
 *
 * 🔴 **既定は今までどおり。** `loaded` / `failed` を渡さない呼び出し側の描画は変えない
 * （渡していない画面は「常に読めている」とみなす）。移行を一度に強制しないため。
 */

type Row = { id: string; name: string };
const COLUMNS: ReadonlyArray<Column<Row>> = [{ key: 'name', header: '名前', cell: (r) => r.name }];
const ROWS: Row[] = [{ id: 'a', name: 'あ' }];

function render(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}): string {
  return renderToStaticMarkup(
    <DataTable<Row>
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      testId="t"
      {...props}
    />,
  );
}

describe('DataTable の読み取り状態 (#896)', () => {
  /*
   * 🔴 **13 表ぶんの契約が、この 1 ファイルに集約された (#896 レビュー MAJOR-2)。**
   *
   * 移行前、横スクロール領域と `role="region"` は**各画面が自前で書いていた**ので、
   * `platform-list-states.test.ts` の「生 `<table>` は `overflowX` の中に置く」が
   * 8 ファイルを守っていた。寄せた結果その主張が守る対象は **1 ファイル
   * （`ProviderConfig`）へ縮み**、残り 13 表の同じ保証は**どこも守らなくなった**。
   *
   * 独立レビューの実測で、`overflowX` を外す / `role="region"` を外す /
   * `scrollRegionLabel` を無視する / loading の `role="status"` を外す、の 4 変異が
   * **すべて生存**した。`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、
   * 前の方式が守っていた変異を当て直す」が言うとおり、**落ちた保証は次にそこを
   * 踏むまで誰にも見えない**。ここで当て直す。
   */
  it('横スクロール領域を持つ（狭幅で列が潰れない / #330 item5）', () => {
    expect(render()).toContain('overflow-x:auto');
  });

  it('スクロール領域はキーボードで到達できる（WCAG 2.1.1 / #330 レビュー）', () => {
    const html = render();
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
  });

  it('scrollRegionLabel を渡すとスクロール領域の名前になる（landmark を区別する）', () => {
    expect(render({ scrollRegionLabel: 'コスト内訳' })).toContain('aria-label="コスト内訳"');
  });

  it('scrollRegionLabel を渡さなければ既定の名前になる', () => {
    expect(render()).toContain('aria-label="テーブル（横スクロール可）"');
  });

  it('読み込み中は読み上げへ届く（role="status" / aria-live）', () => {
    const html = render({ rows: [], loaded: false, failed: false });
    expect(html).toContain('data-testid="t-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('🔴 下界: 行が在るなら表を描く（状態表示に置き換えない）', () => {
    const html = render();
    expect(html).toContain('data-testid="t"');
    expect(html).toContain('あ');
  });

  it('既定（loaded/failed を渡さない）は今までどおり 0 件で EmptyState', () => {
    const html = render({ rows: [], emptyMessage: '部署はありません。' });
    expect(html).toContain('t-empty');
    expect(html).toContain('部署はありません。');
  });

  it('読み込み中は「0 件」と断定しない', () => {
    const html = render({ rows: [], loaded: false, emptyMessage: '部署はありません。' });
    expect(html).not.toContain('部署はありません。');
    expect(html).toContain('t-loading');
  });

  it('失敗は「読み込み中」に化けない', () => {
    /*
     * `data` は失敗しても空のままなので、`loaded` だけを見ると失敗が永遠の
     * 「読み込み中」になる（`read-state.ts` が警告している型）。
     */
    const html = render({ rows: [], loaded: false, failed: true, emptyMessage: '部署はありません。' });
    expect(html).toContain('t-failed');
    expect(html).not.toContain('t-loading');
    expect(html).not.toContain('部署はありません。');
  });

  it('失敗は読み上げへ届く（待ちは role="status" なのに失敗だけ黙っていた・#966）', () => {
    const html = render({ rows: [], loaded: false, failed: true });
    expect(html, '失敗に role="alert" が無い').toContain('role="alert"');
    // 下界: 「常に alert を出す」で満たさない。待ちと 0 件は alert ではない。
    expect(render({ rows: [], loaded: false, failed: false })).not.toContain('role="alert"');
    expect(render({ rows: [], loaded: true })).not.toContain('role="alert"');
  });

  it('読めていて 0 件なら 0 件と言う', () => {
    const html = render({ rows: [], loaded: true, emptyMessage: '部署はありません。' });
    expect(html).toContain('t-empty');
    expect(html).toContain('部署はありません。');
  });

  it('3 つの状態は互いに区別できる', () => {
    const loading = render({ rows: [], loaded: false });
    const failed = render({ rows: [], loaded: false, failed: true });
    const empty = render({ rows: [], loaded: true });
    expect(new Set([loading, failed, empty]).size).toBe(3);
  });

  /*
   * 🔴 **載っているものは消さない。** 再取得が失敗しても、既に描けている行は残す
   * （消すと「更新に失敗したら画面ごと空になる」＝失敗が状況を悪化させる形になる）。
   * `resolveAdminReadState` が `loaded` を最優先するのと同じ理由。
   */
  it('🔴 下界: 行が在れば失敗中でも表を消さない', () => {
    const html = render({ rows: ROWS, loaded: true, failed: true });
    expect(html).toContain('data-testid="t"');
    expect(html).toContain('あ');
    expect(html).not.toContain('t-failed');
  });
});
