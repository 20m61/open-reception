/**
 * `scripts/url-quality-gate.sh` が、外形チェック（lighthouse / OWASP ZAP）を
 * **走らせてよいか**と、走らせた結果を**どう読むか**を判定する。
 *
 * ## なぜ純関数へ出すか
 *
 * `scripts/aws-cloud-deploy.sh` 冒頭と同じ理由 ――「判定ロジックは bash に書かない
 * （bash はテストしづらい）。観測を集めて `.ts` へ渡す」。bash 側は
 * `command -v` / `docker info` の成否を集めるだけの I/O 層にとどめる。
 *
 * ## 直している 2 つの欠陥（2026-09-04、クラウドからの実行で観測）
 *
 * ### 1. 任意ツール未導入が SKIP ではなく FAIL になっていた
 *
 * `scripts/quality-gate.sh` は未導入の任意ツール（gitleaks / semgrep / lhci）を
 * `skip_or_fail` で **SKIP** し、`--strict` のときだけ FAIL にする
 * （`docs/quality-gate.md` の既定）。`url-quality-gate.sh` にはこの規約が無く、
 * docker も Chrome も**無条件 FAIL** だった。クラウドサンドボックスには docker
 * デーモンが無いので、**dev が健全でも smoke は必ず赤くなる**。
 *
 * ### 2. 🔴 インフラ障害が `zap(high-risk)` として報告されていた
 *
 * `zap-baseline.py` の終了コードは 1=高リスク / 2=WARN だが、**`docker run` 自身が
 * 失敗したときも 1** を返す（デーモン停止・イメージ pull 失敗）。旧実装は
 * `[[ "$rc" == 1 ]] && FAILED+=("zap(high-risk)")` と終了コードだけを見ていたため、
 * デーモンが落ちているだけの環境で `RESULT: FAIL — ... zap(high-risk)` と表示していた。
 * **セキュリティ指摘と見分けが付かない**ので、運用者は実在しない高リスクを追いかける
 * （あるいは、本物の high-risk を「またデーモンだろう」と読み飛ばす）。
 *
 * 終了コードだけでは両者を区別できない。区別できる観測は **zap がレポートを
 * 書いたかどうか**である ―― 書いていなければ zap は一度も走っていない。
 *
 * ## SKIP の意味を弱めない
 *
 * SKIP は「赤ではないが green でもない」。`quality-gate.sh` の `skip_unverified`
 * （#640）と同じで、**「落ちなかった」を「通った」と読ませない**。呼び出し側は
 * RESULT 行に SKIP を必ず併記すること。
 */

/** bash 側が集める観測。すべて「実際に使えるか」であって「入っているか」ではない。 */
export interface UrlGateObservation {
  /** `command -v docker` が通るか。 */
  readonly dockerCli: boolean;
  /**
   * `docker info` が通るか（＝デーモンが動いているか）。
   * 🔴 CLI の存在だけでは足りない。クラウドサンドボックスは CLI があってデーモンが無い。
   */
  readonly dockerDaemon: boolean;
  /** lighthouse が使える Chrome/Chromium を解決できるか。 */
  readonly chrome: boolean;
}

export type CheckDisposition =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string };

export interface UrlGatePlan {
  readonly lighthouse: CheckDisposition;
  readonly zap: CheckDisposition;
}

const RUN: CheckDisposition = { kind: 'run' };

/**
 * 未導入を SKIP（既定）か FAIL（`--strict`）かへ振り分ける。
 * `scripts/quality-gate.sh` の `skip_or_fail` と同じ規約。
 */
const missing = (reason: string, strict: boolean): CheckDisposition =>
  strict ? { kind: 'fail', reason: `${reason}; --strict` } : { kind: 'skip', reason };

/**
 * 各チェックを走らせてよいかを決める。
 *
 * **チェック同士を巻き込まない。** docker が無いことは lighthouse の可否と無関係で、
 * 片方の欠落で両方を落とすと「何が測れていないのか」が読めなくなる。
 */
export function planUrlGateChecks(
  observation: UrlGateObservation,
  options: { readonly strict: boolean },
): UrlGatePlan {
  const { strict } = options;

  let zap: CheckDisposition;
  if (!observation.dockerCli) {
    zap = missing('docker が見つかりません', strict);
  } else if (!observation.dockerDaemon) {
    zap = missing('docker デーモンに接続できません（CLI はあります）', strict);
  } else {
    zap = RUN;
  }

  const lighthouse = observation.chrome
    ? RUN
    : missing(
        'lighthouse 用の Chrome を解決できません（CHROME_PATH を設定してください）',
        strict,
      );

  return { lighthouse, zap };
}

/**
 * ZAP の結果。`high-risk` だけが「本当にセキュリティ上の指摘が出た」を意味する。
 * `unverified` は「走らなかった／読めなかった」＝ green でも red でもない。
 */
export type ZapOutcome = 'pass' | 'high-risk' | 'warn' | 'unverified';

/**
 * `docker run ... zap-baseline.py` の結果を読む。
 *
 * 🔴 **終了コードだけで判定しない。** 1 は「高リスク検出」とも「docker が落ちた」とも
 * 読めるので、レポートが書かれたかどうかを併せて見る。レポートが無ければ zap は
 * 一度も走っていないので、`pass` にも `high-risk` にも倒さず `unverified` とする。
 */
export function classifyZapExit(exitCode: number, reportWritten: boolean): ZapOutcome {
  if (!reportWritten) return 'unverified';
  if (exitCode === 0) return 'pass';
  if (exitCode === 1) return 'high-risk';
  if (exitCode === 2) return 'warn';
  return 'unverified';
}
