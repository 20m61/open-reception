/**
 * 管理画面の「読み取りが今どうなっているか」 (#870 増分 04)。
 *
 * ## なぜ型を分けるか
 *
 * 多くの画面は取得結果を `T | null` の 1 変数で持ち、`null` を「読み込み中」と読んでいた。
 * **`null` は「まだ」と「だめだった」の両方を表せてしまう**ので、失敗が「読み込み中…」に
 * 化ける。運用者は終わらない待ちに入り、何が起きたかも再試行の手段も画面に無い。
 *
 * 3 状態を明示的に持てば、その取り違えは**書けなくなる**。
 *
 * ## 拠点別画面との使い分け
 *
 * 拠点別画面（営業時間・サイネージ・在館状況 等）は `./scope-gate.ts` の `resolveScopeGate`
 * を使う。あちらは「どのスコープのデータが載っているか」「拠点一覧そのものが読めたか」まで
 * 見る必要があり、判断材料が多い。こちらは**テナント単位の設定画面**向けの最小版で、
 * 拠点の次元を持たない画面が `resolveScopeGate` の入力を偽装しなくて済むようにするためにある。
 */

/** 読み取りの状態。**「まだ」と「だめだった」を混ぜない。** */
export type AdminReadState = 'loading' | 'failed' | 'loaded';

export type AdminReadStateInput = {
  /** 現在の対象のデータが載っているか。 */
  readonly loaded: boolean;
  /** 直近の読み取りが失敗したか（HTTP エラー・オフラインの双方）。 */
  readonly failed: boolean;
};

/**
 * 読み取りの状態を決める。
 *
 * **載っていることを優先する。** 再取得が失敗しても、既に載っているデータは消さない
 * （消すと「更新に失敗したら画面ごと空になる」という、失敗が状況を悪化させる形になる）。
 */
export function resolveAdminReadState(input: AdminReadStateInput): AdminReadState {
  if (input.loaded) return 'loaded';
  return input.failed ? 'failed' : 'loading';
}
