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
 * 🔴 **そこで自由文の置き場所そのものを消す。** 観測は `{ date, command, status, refs }`
 * だけを持ち、描画はこの module の固定テンプレが行う。**断定形を書ける場所が構造上存在しない**
 * ので、「あなたの環境でも必ず 403 です」を入れるには型を変えるしかなくなる。
 *
 * ## 限界（実装した以上を主張しない）
 *
 * ここが守るのは**この節の中身**だけ。手順など節の外に断定を書く経路は塞いでいない。
 * `date` の正しさも検証していない（人が嘘の日付を書けば古さの表示は狂う）。
 */

/** 何日より前の観測を「古い」と表示するか。 */
export const OBSERVATION_STALE_DAYS = 90;

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
