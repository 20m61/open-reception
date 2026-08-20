/**
 * 環境の観測を**データ**として持ち、固定テンプレだけで描画する (#728)。
 *
 * ## なぜ
 *
 * 委譲プロンプトは委譲先セッションの権限状態を確かめられない（`DelegationInput` に無い）。
 * #705 / #710 と 2 度、確かめていない事実を断定して壊れた。#710 でテストの縛り方を
 * 3 度やり直したが、レビューの実測で 4 クラスの言い換えが依然として素通りした ——
 * **語彙は閉集合、日本語の言い換えは開集合**なので、散文を語彙で守るのは原理的に埋まらない。
 *
 * 🔴 **そこで観測の行から自由文を消す。** 観測は `{ date, command, status, refs }` だけを持ち、
 * 描画はこの module の固定テンプレが行う。
 *
 * ## 限界（実装した以上を主張しない）
 *
 * 🔴 **`command` は唯一の文字列フィールドなので、放っておくと自由文スロットになる。**
 * レビューの実測で `command: 'gh pr create（あなたの環境でも例外なく拒否されます）'` が
 * 全テスト green を通った —— 「断定を書ける場所が構造上無い」という当初の記述は**偽だった**。
 * そこで `COMMAND_SHAPE` で形を縛る（日本語の断定は通らない）。
 *
 * それでも守れるのは**観測の行の中だけ**。次は塞いでいない:
 *  - 節の他の部分（見出し・但し書き・REST 経路の指示）は自由文のまま
 *  - 手順など**節の外**に書いた断定
 *  - `date` の真偽（`2099-01-01` と書けば古さの表示を永久に殺せる）
 */

/** 何日より前の観測を「古い」と表示するか。 */
export const OBSERVATION_STALE_DAYS = 90;

/**
 * `command` として受け付ける形。**散文を弾くためのもの**で、コマンドの正しさは見ない。
 * 英小文字で始まり、英数字と `-_./ :=` だけ（日本語・括弧・読点は通らない）。
 */
const COMMAND_SHAPE = /^[a-z][a-zA-Z0-9 ._/:=-]*$/;

export type EnvironmentObservation = {
  /** 観測した日（`YYYY-MM-DD`）。**必須** —— いつの話か書けない観測は載せない。 */
  readonly date: string;
  /** 観測対象のコマンド。 */
  readonly command: string;
  /** 観測した HTTP ステータス。 */
  readonly status: number;
  /** 根拠の issue / PR 番号。 */
  readonly refs: readonly number[];
};

/** `YYYY-MM-DD` の差を日数で返す。パースできなければ `null`（古さを断定しない）。 */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 観測 1 件を 1 行に描画する。
 *
 * **観測時点を必ず前置する。** 断定を書ける余地を残さないための順序で、
 * 読み手が最初に見るのが「いつの話か」になる。
 *
 * @param at 「今日」。呼び出し側が渡す（この module は時刻を読まない ——
 *   テストと本番で同じ関数を使い、時計に依存した分岐を作らないため）。
 */
export function renderObservation(observation: EnvironmentObservation, at: string): string {
  // 🔴 **散文を `command` に忍ばせない。** ここを通さないと、行のテンプレを固定した意味が消える。
  if (!COMMAND_SHAPE.test(observation.command)) {
    throw new Error(
      `command はコマンドの形（英小文字で始まり英数字と ._/:=- のみ）で書いてください` +
        `—— 観測の行に散文を混ぜないため (#728): ${observation.command}`,
    );
  }
  const age = daysBetween(observation.date, at);
  const stale = age !== null && age > OBSERVATION_STALE_DAYS ? '。🔴 **古い観測です**' : '';
  const refs = observation.refs.map((n) => `#${n}`).join(' / ');
  return (
    `${observation.date} 時点の観測: \`${observation.command}\` が ${observation.status}` +
    `（${refs}）${stale}`
  );
}

/** 観測を箇条書きにする。**行と行の間に自由文は入らない。** */
export function renderObservations(
  observations: readonly EnvironmentObservation[],
  at: string,
): string {
  return observations.map((o) => `- ${renderObservation(o, at)}`).join('\n');
}
