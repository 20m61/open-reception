/**
 * デプロイ対象スタックの絞り込み（#680 / 2026-08-15）。
 *
 * ## なぜ要るか
 *
 * cross-region 参照は「生産側スタックが SSM へ書いた値を、消費側スタックが読む」形。
 * **新規の消費側スタックは、生産側がデプロイされるまで change set を作れない**
 * （`Parameters: [ssm:/cdk/exports/...] cannot be found.`）。
 *
 * wrapper は 3 スタックすべてを gate してからまとめてデプロイするため、消費側の gate が
 * 失敗すると生産側のデプロイにも到達しない。実際に `OpenReception-CfMon-dev` の新規作成で
 * これを踏み、`Web-dev` を先にデプロイする手段が無かった。
 *
 * 🔴 **「gate できないものを黙って通す」で解決してはいけない。** それは gate の意味を壊す。
 * 代わりに**対象を明示的に絞れる**ようにして、運用者が順序を決める。
 *
 * ## 絞り込みは許可リストの部分集合に限る
 *
 * 任意の名前を渡せると、層 1（CloudFormation スタック ARN allowlist）が守っている
 * 「触れるのは dev の 3 本だけ」を**引数で迂回**できてしまう。IAM 側でも塞がっているが、
 * ここでも塞ぐ（多層防御。IAM のエラーは分かりにくく、事故に気づくのが遅れる）。
 */

export type StackSelectionResult =
  | { readonly ok: true; readonly selected: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

/**
 * `--only` の値（カンマ区切り）を許可リストと突き合わせて、デプロイ対象を決める。
 *
 * - 未指定・空白のみ → 全スタック（既定の挙動を変えない）
 * - 指定あり → **元の順序**で部分集合を返す。依存順は呼び出し側の並びが持っているため、
 *   指定順に並べ替えない
 * - 許可リストに無い名前が 1 つでもあれば拒否する（部分的に受け入れない）
 * - 1 本も選ばれない指定は拒否する（「黙って何もしない」を作らない）
 */
export function selectDeployStacks(
  allStacks: ReadonlyArray<string>,
  only: string | undefined,
): StackSelectionResult {
  const raw = typeof only === 'string' ? only.trim() : '';
  if (raw === '') return { ok: true, selected: [...allStacks] };

  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (requested.length === 0) {
    return {
      ok: false,
      message: `--only に有効なスタック名がありません: ${JSON.stringify(only)}`,
    };
  }

  const unknown = requested.filter((s) => !allStacks.includes(s));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: [
        `--only に許可されていないスタック名があります: ${unknown.join(', ')}`,
        `選べるのは次だけです: ${allStacks.join(', ')}`,
      ].join('\n'),
    };
  }

  // 元の順序を保ちつつ重複を落とす。
  const wanted = new Set(requested);
  return { ok: true, selected: allStacks.filter((s) => wanted.has(s)) };
}
