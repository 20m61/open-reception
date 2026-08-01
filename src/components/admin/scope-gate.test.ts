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

  it('操作中でも載っているデータは信じてよい（画面が点滅しない）', () => {
    // busy は「いま操作している」だけで、載っているデータの正しさは変わらない。
    expect(resolveScopeGate({ ...loaded, busy: true }).dataTrusted).toBe(true);
  });

  it('データが載っていないときは断定しない', () => {
    expect(resolveScopeGate({ ...loaded, dataLoaded: false }).dataTrusted).toBe(false);
  });
});
