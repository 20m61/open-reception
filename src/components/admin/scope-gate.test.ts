import { describe, expect, it } from 'vitest';
import { resolveScopeGate } from './scope-gate';

/**
 * 拠点別画面に共通の「いま何をしてよいか」判定 (#554)。
 *
 * 画面ごとに書くと必ずずれる — この repo で P1 になった形はすべて
 * 「ハンドラは止めたのにボタンに写していない」「読みの失敗で書きを殺した」
 * 「取得できていないのに 0 件と断定した」のいずれか。1 箇所に集めて写し忘れを無くす。
 */

const loaded = {
  scopeReady: true,
  dataLoaded: true,
  sitePending: false,
  busy: false,
  listStatus: 'ready',
  loadFailed: false,
  hasSites: true,
} as const;

describe('resolveScopeGate', () => {
  it('現在のスコープのデータが載っていれば操作と断定を許す', () => {
    const g = resolveScopeGate(loaded);
    expect(g.canMutate).toBe(true);
    expect(g.canRefresh).toBe(true);
    expect(g.dataTrusted).toBe(true);
    expect(g.unavailable).toBeNull();
  });

  it('前スコープのデータが残っている間は変更を止める', () => {
    // 見出しとセレクタが B を指しているのに A のデータを編集・削除させない。
    expect(resolveScopeGate({ ...loaded, dataLoaded: false }).canMutate).toBe(false);
  });

  it('拠点切替の遷移が確定するまで変更を止める', () => {
    expect(resolveScopeGate({ ...loaded, sitePending: true }).canMutate).toBe(false);
  });

  it('実行中は二重操作を止める', () => {
    expect(resolveScopeGate({ ...loaded, busy: true }).canMutate).toBe(false);
  });

  it('拠点が確定していなければ再取得も止める（サイレント no-op を作らない）', () => {
    expect(resolveScopeGate({ ...loaded, scopeReady: false, dataLoaded: false }).canRefresh).toBe(
      false,
    );
  });

  /**
   * **読みの失敗で書きを殺さない** (#552 で実際に P1 になった形)。
   *
   * 一覧に依存しない書き込み（新規作成）は、一覧が取れなくても実行できなければならない。
   * 作成ゲートに一覧の取得状態を混ぜたせいで、**GET が 1 回失敗しただけで登録が永久に
   * 無効化**され、端末交換の復旧経路が止まった。
   */
  it('一覧が取れなくても新規作成は止めない', () => {
    const g = resolveScopeGate({ ...loaded, dataLoaded: false, loadFailed: true });
    expect(g.canCreate).toBe(true);
    // 既存行への操作は別。載っているのが前スコープの行かもしれないので止める。
    expect(g.canMutate).toBe(false);
  });

  it('拠点が確定していなければ新規作成は止める', () => {
    // どの拠点に作るか決まっていない状態で作らせると、既定拠点に紛れ込む。
    expect(resolveScopeGate({ ...loaded, scopeReady: false, dataLoaded: false }).canCreate).toBe(
      false,
    );
  });

  it('拠点切替の遷移中と実行中は新規作成も止める', () => {
    expect(resolveScopeGate({ ...loaded, sitePending: true }).canCreate).toBe(false);
    expect(resolveScopeGate({ ...loaded, busy: true }).canCreate).toBe(false);
  });

  it('取得に失敗しても再取得は止めない（復帰手段を残す）', () => {
    // ここを止めると画面リロード以外に抜ける道が無くなる。
    const g = resolveScopeGate({ ...loaded, dataLoaded: false, loadFailed: true });
    expect(g.canRefresh).toBe(true);
    expect(g.unavailable).toBe('load-failed');
  });

  it('拠点一覧の失敗を取得の失敗より優先して伝える', () => {
    // 拠点が確認できないのに「データを取得できませんでした」と言うと原因を取り違える。
    const g = resolveScopeGate({
      ...loaded,
      scopeReady: false,
      dataLoaded: false,
      loadFailed: true,
      listStatus: 'error',
    });
    expect(g.unavailable).toBe('site-list-error');
  });

  it('まだ失敗していなければ「読み込み中」と言う', () => {
    expect(resolveScopeGate({ ...loaded, dataLoaded: false }).unavailable).toBe('loading');
  });

  /**
   * **拠点が 1 つも無いテナントを「終わらない読み込み」にしない** (#554 レビュー M7)。
   *
   * `resolveSiteScopeState` は拠点 0 件のとき `ready:false` を返す（どの拠点を指すか
   * 決まらないので正しい）。これを素朴に `loading` へ落とすと、**拠点をまだ登録して
   * いないテナント**という正常な運用状態が、永久に回るスピナーに化ける。
   */
  it('拠点が 1 つも無いときは「読み込み中」と言わない', () => {
    const g = resolveScopeGate({
      ...loaded,
      scopeReady: false,
      dataLoaded: false,
      hasSites: false,
    });
    expect(g.unavailable).toBe('no-site');
  });

  it('拠点が 1 つも無いときは作成も変更もさせない', () => {
    // どの拠点に作るか決まらない。まず拠点を登録してもらう。
    const g = resolveScopeGate({ ...loaded, scopeReady: false, dataLoaded: false, hasSites: false });
    expect(g.canCreate).toBe(false);
    expect(g.canMutate).toBe(false);
  });

  it('一覧をまだ取得中なら「拠点が無い」と断定しない', () => {
    // `loading` の間は `hasSites` が偽でも、それは「まだ分からない」であって 0 件ではない。
    const g = resolveScopeGate({
      ...loaded,
      scopeReady: false,
      dataLoaded: false,
      hasSites: false,
      listStatus: 'loading',
    });
    expect(g.unavailable).toBe('loading');
  });

  /**
   * **言っていることと押せることを食い違わせない** (#554 レビュー N6)。
   *
   * 一度 ready になったあとの再取得が失敗すると、`sites` は残るので `scopeReady` は真のまま
   * `listStatus` だけ `error` になる。このとき画面は「拠点を確認できないため変更できません」と
   * 出すのに、門が `listStatus` を見ていないと**保存ボタンは有効なまま**になる。
   */
  it('拠点一覧を確認できないときは、データが載っていても変更させない', () => {
    const g = resolveScopeGate({ ...loaded, listStatus: 'error' });
    expect(g.canMutate).toBe(false);
    expect(g.canCreate).toBe(false);
    // 再取得は止めない（復帰手段を残す）。
    expect(g.canRefresh).toBe(true);
  });

  it('操作中でも載っているデータは信じてよい（画面が点滅しない）', () => {
    // busy は「いま操作している」だけで、載っているデータの正しさは変わらない。
    expect(resolveScopeGate({ ...loaded, busy: true }).dataTrusted).toBe(true);
  });

  it('データが載っていないときは断定しない', () => {
    expect(resolveScopeGate({ ...loaded, dataLoaded: false }).dataTrusted).toBe(false);
  });
});
