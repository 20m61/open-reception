/**
 * 変更範囲の分類 (issue #424 / 開発速度)。
 *
 * ゲートの重いステップ（build / e2e / lighthouse / sast）は**ソースを入力に取る**。文書だけを
 * 触った周回ではその入力が 1 バイトも変わらないので、結果は前回と同一にしかならない。
 * それでも毎回 10 分払っていた（実測: `--full` 平均 598s のうち build+e2e+lighthouse+sast が
 * 446s = 75%。あるセッションでは 5 PR 中 3 本が文書のみ）。
 *
 * 設計原則:
 *  - 副作用なし（I/O・git 非依存）。変更パスを**受け取る**だけ。
 *  - **厳しい方へ倒す。** 判断は「docs と断定できるものだけを docs とみなす」で、少しでも
 *    分類できないものが混ざれば `code` にする。逆に倒すと検証していないコードが green になる。
 *  - この分類は**検証の省略を正当化するもの**なので、`change-risk.ts`（偽陽性に倒す検出器）とは
 *    倒す方向が逆になる。同じモジュールに置かない理由でもある。
 */

/**
 * 変更範囲。
 *  - `docs`: 文書のみ。ソースを入力に取るステップの結果が変わり得ない。
 *  - `code`: それ以外（不明なパスを含む）。全ステップを回す。
 */
export const CHANGE_SCOPES = ['docs', 'code'] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

/**
 * 文書と断定できるパス。
 *
 * **ここに足すときは「build / e2e / lighthouse / sast の入力になり得ないか」を確認する。**
 * `docs/` がコード・テスト・設定から参照されていないことは導入時に確認済み
 * （`rg "from '.*docs/"` 等がヒットゼロ。`playwright.config.ts` のコメント言及のみ）。
 */
const DOCS_PATTERNS: ReadonlyArray<RegExp> = [
  /^docs\//, // 設計・運用文書
  /^[^/]+\.md$/, // ルート直下の md（README / CLAUDE.md 等）
  /^\.github\/(?:[^/]+\/)*[^/]+\.md$/, // Issue / PR テンプレート
  /^LICENSE$/,
];

/**
 * `docs` と分類してよいのは**全パスが文書パターンに一致するとき**だけ。
 *
 * 意図的に `code` へ倒すもの: `src/` `tests/` `scripts/` `infra/` `public/` `package*.json`
 * 各種 config、`.claude/`（エージェントの挙動を変える設定。文書に見えても config 扱いにする）。
 * 列挙ではなく「docs allowlist の補集合」で判定するので、**新しい種類のファイルが増えても
 * 自動的に `code` 側へ落ちる**（allowlist を書き忘れて検証が飛ぶ事故を防ぐ）。
 */
export function classifyChangeScope(paths: ReadonlyArray<string>): ChangeScope {
  // 変更ゼロは `code` にする。「何も変わっていない」のではなく「収集に失敗した」可能性が
  // あり、そこで検証を省くと最悪の方向へ倒れる。
  if (paths.length === 0) return 'code';
  return paths.every((path) => DOCS_PATTERNS.some((re) => re.test(path))) ? 'docs' : 'code';
}

/**
 * その範囲で省略してよいゲートステップ。
 *
 * 残すもの（`docs` でも実行する）とその理由:
 *  - typecheck / lint / unit … **スコープ検出器自体のバグに対するトリップワイヤ**。ソースが
 *    混ざったのに `docs` と誤判定した場合、ここで大半の破壊が捕まる。合計 148s と安い。
 *  - secrets (gitleaks) … 文書にも鍵は混入しうる。
 *  - audit … 2s。
 */
/**
 * 実行モードを反映した最終スコープ。
 *
 * **定期実行（`--strict`）では省略しない。** `--full --strict` は「マージ駆動では検出できない
 * 時間経過由来の劣化」（依存 advisory の更新・ブラウザ更新・ツールのルール変更）を捕まえるための
 * 実行で、コードが変わっていないことこそが前提（`docs/quality-gate.md` 定期運用 / #318）。
 * それが文書のみのブランチで走ったからといって e2e や sast を省略したら、その実行が存在する
 * 意味が無くなる。
 *
 * 倒す方向は一方通行（`docs` → `code` のみ。`code` を緩めることはしない）。
 */
export function effectiveScope(
  scope: ChangeScope,
  options: { strict: boolean },
): ChangeScope {
  return options.strict ? 'code' : scope;
}

export const SKIPPABLE_STEPS = ['build', 'e2e', 'lighthouse', 'sast', 'vrm', 'infra'] as const;
export type SkippableStep = (typeof SKIPPABLE_STEPS)[number];

/**
 * そのステップをこの範囲で省略してよいか。
 *
 * **一覧はここが唯一の真実源。** `scripts/quality-gate.sh` は `scripts/change-scope.ts` の
 * 出力（`skip=<step>`）を読むだけで、shell 側に同じ一覧を持たない（二重管理にすると
 * 片方だけ直ってズレる）。
 */
export function isStepSkippable(step: string, scope: ChangeScope): boolean {
  return scope === 'docs' && (SKIPPABLE_STEPS as ReadonlyArray<string>).includes(step);
}
