/**
 * wrapper（`scripts/aws-cloud-deploy.sh`）が AWS へ触れる前に、依存する外部コマンドの
 * 有無を判定する (#680)。
 *
 * ## なぜ要るか
 *
 * クラウドサンドボックスに `aws` CLI が入っておらず、`collect_observation` の
 * `aws sts get-caller-identity` が `aws: command not found` で失敗した。既存の実装は
 * これをそのまま「AWS 認証情報を解決できません」と報告していた ―― 資格情報は無関係で、
 * 実際には**バイナリが存在しなかった**。`CLAUDE.md` の「直すべきは 4 つ目の推測ではなく
 * 観測」（`lesson-fix-the-observation-not-the-fourth-guess.md`）と同じ形の欠陥で、診断が
 * 誤った層（資格情報）を名指しし、無関係な対処（再発行）へ運用者を誘導していた。
 *
 * この判定は AWS へ一切触れる前に走る必要があるので、`collect_observation` の
 * `aws sts get-caller-identity` より前に置く。判定ロジックはここ（純関数）に置き、
 * `scripts/aws-cloud-deploy.sh` / `scripts/aws-command-preflight.ts` は
 * `command -v` で存在を集めて渡すだけの I/O 層にとどめる。
 *
 * ## 対象コマンドの選定（#680 時点の判断）
 *
 * - **`aws`（含む）**: wrapper の `preflight`/`diff`/`deploy` が直接呼ぶ。
 *   `scripts/cloud-setup.sh` が入れて初めて存在が保証される ―― `gh`/`gitleaks`/`semgrep`/
 *   Playwright と同じカテゴリで、**土台（ベースイメージ）の一部ではない**。
 *   今回の実インシデントの当事者。
 * - **`node` / `npx`（除外）**: このリポジトリの開発ループそのものが Node 前提
 *   （typecheck/lint/test/build、`quality-gate.sh`、`gate-stamp.sh`、そして
 *   `collect_observation` 自身が使う `json_field()` の `node -e` や `npx tsx`）。
 *   欠けていれば wrapper に到達する前に他の何もかもが動かず、失敗メッセージも
 *   「node: command not found」のように素直で誤診断を招かない。今回の実インシデントで
 *   誤診断（層を取り違える）が起きたのは `aws` だけであり、対称的に全コマンドへ
 *   検査対象を広げる理由がない。
 * - **`git`（除外）**: リポジトリを clone する時点で存在が前提（cloud sandbox はリポジトリの
 *   clone から始まる）。加えて `collect_observation` は既に `git status` /
 *   `git branch -r --contains HEAD` の失敗を個別に検知して fail-closed しており
 *   （Important 2 / R5 の回帰テスト、`tests/hooks/aws-cloud-deploy.test.ts`）、`git` の
 *   欠如や失敗は既に「判定不能」として誠実に報告される。誤った層を名指ししていない。
 * - **`gitleaks`（除外）**: wrapper 自身（`aws-cloud-deploy.sh`）は呼ばない。`verify`
 *   サブコマンド経由で `quality-gate.sh` が使うが、そちらは「無ければ SKIP」という
 *   **意図的な**設計（`docs/cloud-dev-environment.md` §1）であり、ここで hard-fail に
 *   すると SKIP の意味を壊す。SKIP を FAIL として機械的に検出する仕組みは
 *   `--strict` フラグとして既に別に用意されている。
 */

export type CommandAvailability = Readonly<Record<string, boolean>>;

/** wrapper が AWS へ触れる前に必要とする外部コマンド。理由は本ファイル冒頭を参照。 */
export const REQUIRED_EXTERNAL_COMMANDS: ReadonlyArray<string> = ['aws'];

export type CommandPreflightVerdict = {
  readonly ok: boolean;
  readonly missing: ReadonlyArray<string>;
};

/**
 * `required` に列挙されたコマンドのうち、`observed[cmd] !== true` のものを欠落として
 * 報告する。
 *
 * **キー自体が無い場合も欠落扱いにする**（`observed[cmd]` が `undefined` なら
 * `!== true` が真になる）。呼び出し側が値を渡し忘れても「判定不能を PASS に丸め込む」
 * 側には倒れない ―— `deploy-preflight.ts` の `credentialSecondsRemaining` と同じ設計。
 */
export function evaluateCommandAvailability(
  observed: CommandAvailability,
  required: ReadonlyArray<string> = REQUIRED_EXTERNAL_COMMANDS,
): CommandPreflightVerdict {
  const missing = required.filter((cmd) => observed[cmd] !== true);
  return { ok: missing.length === 0, missing };
}

/**
 * 欠落コマンドを、原因の層（インストール）を明示したメッセージへ整形する。
 *
 * 「AWS 認証情報を解決できません」のような誤った層を名指ししないことが目的の文言なので、
 * 「認証情報」という語を含めない。
 *
 * 🔴 **文言に `scripts/cloud-setup.sh`（`scripts/` プレフィックス付き）を書かない。**
 * `scripts/check-script-wiring.ts`（#656）は `src/**` 配下のファイルを「自動配線元」として
 * 走査し、`scripts/<name>` という形の文字列を「呼び出し」とみなす。この文言は一メッセージ
 * であって呼び出しではないが、検出器はコード中の文字列リテラルとコメントを区別できず、
 * `scripts/cloud-setup.sh` という部分文字列がここにあるだけで `cloud-setup.sh` を
 * 「もう自動配線された」と誤判定する（`MANUAL_ONLY_ALLOWLIST` のドリフト検出が誤発火する）。
 * ベース名だけを書けば人間にも agent にも十分特定できるので、`scripts/` は付けない。
 */
export function formatMissingCommandMessage(missing: ReadonlyArray<string>): string {
  return (
    `必要なコマンドが見つかりません: ${missing.join(', ')}。` +
    `インストールが未完了です（資格情報の問題ではありません）。cloud-setup.sh` +
    `（クラウド環境ダイアログの Setup script が実行しているはずの内容）を確認してください。`
  );
}
