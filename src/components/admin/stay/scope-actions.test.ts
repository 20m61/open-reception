import { describe, expect, it } from 'vitest';
import { resolveStayScopeActions } from './scope-actions';

/**
 * 在館状況の「いま何をしてよいか」を 1 つの値から導く (#554 / 第 111 wave)。
 *
 * この画面に固有の危険がある: **空の在館者一覧は「誰も建物に居ない」と読める。**
 * 拠点切替の途中や取得失敗で 0 件を出すと、避難確認のような場面で嘘をつく。
 * だから「まだ分かっていない」と「0 人だと分かっている」を必ず区別する。
 */

const loaded = {
  scopeReady: true,
  staysLoaded: true,
  sitePending: false,
  busy: false,
  listStatus: 'ready',
  loadFailed: false,
} as const;

describe('resolveStayScopeActions', () => {
  it('現在の拠点のデータが載っていれば集計と操作を許す', () => {
    const a = resolveStayScopeActions(loaded);
    expect(a.canMutate).toBe(true);
    expect(a.canRefresh).toBe(true);
    expect(a.showSummary).toBe(true);
  });

  it('拠点切替中は「在館 0 人」と言わない', () => {
    // 前拠点の行を捨ててから新しい一覧が届くまでの窓。ここで 0 を出すと、
    // 「この拠点には誰も居ない」と読めてしまう。
    const a = resolveStayScopeActions({ ...loaded, staysLoaded: false });
    expect(a.showSummary).toBe(false);
    expect(a.emptyMessage).not.toContain('在館者はいません');
  });

  it('拠点切替中は退館・取消を止める', () => {
    // 見出しが B を指しているのに A の滞在を退館させない。
    expect(resolveStayScopeActions({ ...loaded, staysLoaded: false }).canMutate).toBe(false);
    expect(resolveStayScopeActions({ ...loaded, sitePending: true }).canMutate).toBe(false);
  });

  it('実行中は二重操作を止める', () => {
    expect(resolveStayScopeActions({ ...loaded, busy: true }).canMutate).toBe(false);
  });

  it('拠点が確定していなければ更新も止める', () => {
    // `load()` が早期 return するので、押せるのに何も起きない
    // **サイレント no-op** になる（この repo の既知 P1 パターン）。
    const a = resolveStayScopeActions({ ...loaded, scopeReady: false, staysLoaded: false });
    expect(a.canRefresh).toBe(false);
    expect(a.canMutate).toBe(false);
  });

  it('拠点一覧を取得できないことを空一覧と区別して伝える', () => {
    const a = resolveStayScopeActions({
      ...loaded,
      scopeReady: false,
      staysLoaded: false,
      listStatus: 'error',
    });
    expect(a.emptyMessage).toContain('拠点');
    expect(a.showSummary).toBe(false);
  });

  it('読み込みが終わって 0 件なら、0 件だと断定してよい', () => {
    const a = resolveStayScopeActions(loaded);
    expect(a.emptyMessage).toContain('在館者はいません');
    expect(a.showSummary).toBe(true);
  });

  it('滞在の取得に失敗したら「読み込み中」のままにしない', () => {
    // 失敗しても `staysLoaded` は偽のままなので、素朴に書くと**永久に「読み込み中…」**を
    // 出し続ける。正常系で潰した食い違いが失敗系に残る、この repo の頻出パターン。
    const a = resolveStayScopeActions({ ...loaded, staysLoaded: false, loadFailed: true });
    expect(a.emptyMessage).not.toContain('読み込み中');
    expect(a.emptyMessage).toContain('取得できませんでした');
    expect(a.showSummary).toBe(false);
  });

  it('滞在の取得に失敗しても再取得はできる', () => {
    // ここを止めると失敗から復帰する手段が無くなる（画面リロードしか残らない）。
    expect(resolveStayScopeActions({ ...loaded, staysLoaded: false, loadFailed: true }).canRefresh).toBe(
      true,
    );
  });

  it('拠点一覧の失敗は滞在の失敗より優先して伝える', () => {
    // 拠点が確認できないのに「滞在を取得できませんでした」と出すと、原因を取り違える。
    const a = resolveStayScopeActions({
      ...loaded,
      scopeReady: false,
      staysLoaded: false,
      loadFailed: true,
      listStatus: 'error',
    });
    expect(a.emptyMessage).toContain('拠点');
  });

  it('操作中でも集計は出したままにする（画面が点滅しない）', () => {
    // busy は「いま操作している」だけで、載っているデータの正しさは変わらない。
    expect(resolveStayScopeActions({ ...loaded, busy: true }).showSummary).toBe(true);
  });
});
