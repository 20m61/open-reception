import type { SiteListStatus } from './site-context';

/**
 * 拠点別画面に共通の「いま何をしてよいか / 何を断定してよいか」判定 (#554)。
 *
 * ## なぜ共有するか
 *
 * `docs/loop-queue.md` に残っているとおり、拠点スコープ移行でレビューが見つけた P1 は
 * ほぼ 1 つの型だった — **ある画面で解いた対策を別の画面へ写していない**。
 * 共有フック（`useSiteScope`）へ寄せた分は横展開できたが、**「どのスコープのデータが
 * 載っているか」を各画面の state で持っていた部分**が毎回穴になった。
 * 判定をここへ集めて、画面側は「何と表示するか」だけを持つ。
 *
 * 具体的に潰している 3 つの形:
 *  1. ハンドラは止めたのに**ボタンの `disabled` に写していない**（サイレント no-op）
 *  2. **読みの失敗で書きを殺す**（一覧 GET 1 回の失敗で復旧経路が永久停止する）
 *  3. 取得できていないのに**「0 件」と断定する**（空表示が事実として読まれる）
 *
 * 認可ではない。実際の認可は各 API が actor を正として検証する。
 */
export type ScopeGateInput = {
  /** 対象拠点が確定したか（`resolveSiteScopeState` の `ready`）。 */
  scopeReady: boolean;
  /** いま画面に載っているデータが、現在のスコープ（テナント + 拠点）のものか。 */
  dataLoaded: boolean;
  /** 拠点切替の URL 遷移が確定するまで真。 */
  sitePending: boolean;
  /** 変更操作の実行中。 */
  busy: boolean;
  /** 拠点一覧の取得状態。 */
  listStatus: SiteListStatus;
  /** その画面のデータ取得に失敗したか。 */
  loadFailed: boolean;
  /**
   * このテナントに拠点が 1 つでも在るか。
   *
   * 0 件は**正常な運用状態**（まだ拠点を登録していないテナント）なのに、
   * `resolveSiteScopeState` が `ready:false` を返すため、素朴に扱うと
   * 「終わらない読み込み中」に化ける (#554 レビュー M7)。
   */
  hasSites: boolean;
};

/**
 * データを出せない理由。`null` は「出せる」。
 *
 * 文言そのものは画面ごとに違う（在館状況とサイネージ設定では言うべきことが違う）ので、
 * ここでは**理由の種別だけ**を返し、表示は画面側が決める。
 */
export type ScopeUnavailableKind =
  | 'site-list-error'
  /** 拠点が 1 つも無い。エラーではなく「まず拠点を登録する」へ案内すべき状態。 */
  | 'no-site'
  | 'load-failed'
  | 'loading';

export type ScopeGate = {
  /** 再取得してよいか。偽ならボタンも無効にする。 */
  canRefresh: boolean;
  /**
   * **一覧に依存しない書き込み**（新規作成）をしてよいか。
   *
   * `canMutate` と分けているのが要点。作成は「どの拠点に作るか」さえ決まっていれば
   * 実行でき、一覧が取れているかとは無関係。ここに一覧の取得状態を混ぜると、
   * **GET が 1 回失敗しただけで登録が永久に無効化**され、復旧経路ごと止まる
   * （#552 で実際に P1 になった）。
   */
  canCreate: boolean;
  /**
   * **載っている行に対する操作**（保存・削除・状態変更）をしてよいか。
   *
   * こちらは `dataLoaded` を要求する。前スコープの行が残ったまま操作させると、
   * 見出しは B なのに A の資源を壊す。
   */
  canMutate: boolean;
  /** 載っているデータを事実として扱ってよいか（集計・件数・「0 件です」の断定）。 */
  dataTrusted: boolean;
  /** 出せない理由。`null` なら確定している。 */
  unavailable: ScopeUnavailableKind | null;
};

export function resolveScopeGate(input: ScopeGateInput): ScopeGate {
  const { scopeReady, dataLoaded, sitePending, busy, listStatus, loadFailed, hasSites } = input;

  /**
   * 拠点そのものが信用できない／存在しない状態では**書き込みを許さない**。
   *
   * ここは「読みの失敗で書きを殺すな」の例外にあたる。拠点一覧は**書き込み先そのものを
   * 決める読み**なので、確認できないなら安全な書き込み先が無い（無関係な読みを書きの
   * ゲートに混ぜた #552 の罠とは別物）。復帰は `canRefresh` に残してある。
   * これが無いと「拠点を確認できないため変更できません」と表示しながら保存ボタンが
   * 押せる状態になる（レビュー N6）。
   */
  const scopeUnusable = listStatus === 'error' || !hasSites;

  /**
   * 出せない理由。**拠点側を優先する** — 拠点が確認できていないのに「データを取得
   * できませんでした」と出すと、原因を取り違えてその画面の API を疑うことになる。
   */
  const unavailable = (): ScopeUnavailableKind | null => {
    if (dataLoaded) return null;
    if (listStatus === 'error') return 'site-list-error';
    // `loading` / `idle` の間の 0 件は「まだ分からない」であって「無い」ではない。
    if (!hasSites && listStatus === 'ready') return 'no-site';
    if (loadFailed) return 'load-failed';
    return 'loading';
  };

  return {
    // 拠点が確定していないと取得処理は早期 return する。押せるのに何も起きない状態を
    // 作らないため、ボタン側も同じ条件で止める。**取得失敗では止めない** —
    // 止めると失敗から復帰する手段が画面リロードだけになる。
    canRefresh: scopeReady && !sitePending && !busy,
    // **`dataLoaded` を含めない。** 読みの失敗で書きを殺さないため（#552）。
    canCreate: scopeReady && !sitePending && !busy && !scopeUnusable,
    canMutate: dataLoaded && !sitePending && !busy && !scopeUnusable,
    // **`busy` は含めない。** 操作中でも載っているデータの正しさは変わらないので、
    // 消すと操作のたびに画面が点滅する。
    dataTrusted: dataLoaded,
    unavailable: unavailable(),
  };
}
