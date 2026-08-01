import type { SiteListStatus } from '../site-context';

/**
 * 在館状況画面の「いま何をしてよいか / 何を断定してよいか」を 1 つの値へ集約する純関数
 * (#554、拠点スコープ移行)。
 *
 * ## なぜ 1 箇所に集めるか
 *
 * この repo が繰り返してきた欠陥は「ハンドラは止めたのにボタンの `disabled` に写して
 * いない（＝押せるのに何も起きない**サイレント no-op**）」あるいはその逆だった
 * （#552 / #556 で連続して P1 になっている）。**ハンドラとボタンが同じ 1 つの値を見る**
 * 形にして、分岐しようがなくする。
 *
 * ## この画面に固有の危険
 *
 * **空の在館者一覧は「誰も建物に居ない」と読める。** 拠点切替の途中や拠点一覧の取得失敗で
 * 0 件・集計 0 を出すと、避難確認のような場面で嘘をつく。「まだ分かっていない」と
 * 「0 人だと分かっている」を必ず区別する。
 *
 * PII は扱わない（滞在は受付番号での識別のみ）。認可は API 側が actor を正として検証する。
 */
export type StayScopeInput = {
  /** 対象拠点が確定したか（`resolveSiteScopeState` の `ready`）。 */
  scopeReady: boolean;
  /** いま画面に載っている滞在が、現在のスコープ（テナント + 拠点）のものか。 */
  staysLoaded: boolean;
  /** 拠点切替の URL 遷移が確定するまで真。 */
  sitePending: boolean;
  /** 退館・取消の実行中。 */
  busy: boolean;
  /** 拠点一覧の取得状態。 */
  listStatus: SiteListStatus;
  /**
   * 滞在一覧の取得に失敗したか。
   *
   * 失敗しても `staysLoaded` は偽のままなので、これを見ないと**永久に「読み込み中…」**を
   * 出し続ける（正常系で潰した食い違いが失敗系に残る、この repo の頻出パターン）。
   */
  loadFailed: boolean;
};

export type StayScopeActions = {
  /** 再取得してよいか。偽のときボタンも無効にする（押せるのに無反応、を作らない）。 */
  canRefresh: boolean;
  /** 退館・取消を実行してよいか。ハンドラと行のボタンが**同じこの値**を見る。 */
  canMutate: boolean;
  /** 集計（在館中◯人）を断定してよいか。 */
  showSummary: boolean;
  /** 一覧が空のときの文言。 */
  emptyMessage: string;
};

export function resolveStayScopeActions(input: StayScopeInput): StayScopeActions {
  const { scopeReady, staysLoaded, sitePending, busy, listStatus, loadFailed } = input;

  /**
   * **拠点一覧の失敗を優先する。** 拠点が確認できていないのに「滞在を取得できません
   * でした」と出すと、原因を取り違えて滞在 API を疑うことになる。
   */
  const unloadedReason = (): string => {
    if (listStatus === 'error') return '拠点を確認できないため、在館状況を表示できません。';
    if (loadFailed) return '在館状況を取得できませんでした。';
    return '読み込み中…';
  };

  return {
    // 拠点が確定していないと `load()` は早期 return する。押せるのに何も起きない状態に
    // しないため、ボタン側も同じ条件で止める。**取得失敗では止めない** — ここを止めると
    // 失敗から復帰する手段が画面リロードだけになる。
    canRefresh: scopeReady && !sitePending && !busy,
    // 見出しとセレクタが B を指しているのに A の滞在を退館させない。
    canMutate: staysLoaded && !sitePending && !busy,
    // **`busy` は含めない。** 操作中でも載っているデータの正しさは変わらないので、
    // 集計を消すと操作のたびに画面が点滅する。
    showSummary: staysLoaded,
    emptyMessage: staysLoaded ? '在館者はいません。' : unloadedReason(),
  };
}
