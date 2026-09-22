/**
 * 試行予算の**検出信号**（#1021 AC4 / レビュー M4）。
 *
 * ## なぜ要るか
 *
 * この増分は「攻撃者が受付の初回認可を一時的に閉じられる」ことを**意図的に受け入れた**
 * 設計である。受け入れた欠陥に検出信号が無いと、来訪者に「担当者へお声がけください」と
 * 言われた担当者が**なぜ閉じたのかを知る手段を持たない** —— 10 分の停止が
 * 原因不明の長時間停止に化ける。攻撃を受けていること自体が観測できない。
 *
 * ## 何を残さないか
 *
 * 🔴 **入力値（PIN / パスワード）を一切残さない。** 残すのは「どの経路が」「閉じた」
 * という事実だけで、発信元 IP も**ここには載せない**（`rules/pii-secret-minimization.md`。
 * IP が要る調査は既存の高詳細監査 `auditContextFromRequest` の領分で、
 * そちらは認可済みの操作に紐づく）。
 *
 * ## なぜラッチするか
 *
 * 🔴 **未認証経路から呼ばれる。** 毎回出すと**出力量を攻撃者が制御できる**
 * （ログ課金と、他の信号が埋まることの両方が起きる）。同じ理由で
 * `src/lib/auth/secret-unavailable.ts` がラッチを持っており、**規約を 2 通りにしない**。
 */

/** ラッチの窓。この間は同じ経路について 1 度だけ出す。 */
const LATCH_MS = 60_000;

const lastReported = new Map<string, number>();

function latched(tag: string, now: number): boolean {
  const previous = lastReported.get(tag);
  if (previous !== undefined && now - previous < LATCH_MS) return true;
  lastReported.set(tag, now);
  return false;
}

/**
 * 予算を使い切って断ったことを記録する。
 *
 * 運用者が `429` を見たときに「設定ではなく試行制限である」と辿れるようにするのが目的。
 */
export function reportAttemptBudgetExceeded(scope: string, now: number = Date.now()): void {
  if (latched(`exceeded:${scope}`, now)) return;
  console.warn(
    `[security] attempt budget exhausted for ${scope}; further attempts are answered with 429 ` +
      `until the window expires (#1021 AC4). Values are never logged.`,
  );
}

/** 帳簿が読めない／書けないことを記録する（fail-closed で 503 を返す側）。 */
export function reportAttemptStoreUnavailable(scope: string, now: number = Date.now()): void {
  if (latched(`unavailable:${scope}`, now)) return;
  console.error(
    `[security] attempt budget store is unavailable for ${scope}; ` +
      `refusing attempts (fail-closed) so the limit cannot be removed by breaking the backend (#1021 AC4).`,
  );
}

/** テスト用: ラッチを戻す。 */
export function __resetAttemptReports(): void {
  lastReported.clear();
}
