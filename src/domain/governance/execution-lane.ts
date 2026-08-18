/**
 * 実行レーンの分離 (issue #675)。
 *
 * ## 何のためにあるか
 *
 * 開発は Claude Code on the web（クラウドセッション）が既定になった（2026-08-18）。
 * #675 の必須原則のうち、この運用形で意味を持つのは
 * **「production 権限・秘密情報・デプロイは local privileged lane に固定する」**である。
 * ここはその境界を**機械可読な 1 か所**に置き、`scripts/hooks/guard-destructive.sh` から
 * 強制する。
 *
 * ## 既定は cloud-eligible
 *
 * **分からないものを止めない。** 移管の目的はクラウドで回すことなので、既定を
 * local-required にすると移管そのものを妨げる。止めるのは列挙したものだけ。
 *
 * ## 何を載せないか（載せた方が目立つが、載せると腐るもの）
 *
 * 🔴 **本番デプロイは載せない。** 設計時の候補だったが、`scripts/aws-cloud-deploy.sh` が
 * `OR_DEPLOY_ENV != dev` を**全環境で**拒否している（脅威 T13、同ファイルの環境固定）。
 * ここへ足しても**一致し得ないルール**にしかならず、「ガードが効いている」ように見えて
 * 実際には何も見ていない状態を作る（2026-08-15 に IAM の Deny で同じ形を踏んだ
 * ―― 一致しない資源型への Deny が negative test を偽 PASS にしていた）。
 *
 * 🔴 **VRT ベースラインの更新は載せない。** `--update-snapshots` は platform 込みの
 * ファイル名を書くため、**linux 側はクラウドでしか取り直せない**（第 94 wave で実施済み）。
 * ここで止めると正しい作業ができなくなる。
 *
 * ## 作らなかったもの（#675 の残り）
 *
 * task packet / ack TTL / heartbeat TTL / dispatcher は**作らない**。それらは
 * 「ローカルからクラウドへ投げ、ローカルが run-id と status を追う」形を前提にするが、
 * 2026-08-18 に運用形が「人が web セッションで直接作業する」へ決まり、追う主体が居なくなった。
 * 証拠ベースの状態（PR という receipt を見る）側は `gate-run-evaluation.ts` が担う。
 */

/** その作業をどこで回してよいか。 */
export type ExecutionLane = 'cloud-eligible' | 'local-required';

/** ローカル限定にする理由と、代わりにどこでやるか。 */
export interface LaneRule {
  /** 短い識別子（メッセージとテストで使う）。 */
  readonly id: string;
  /** なぜクラウドで走らせてはいけないか。 */
  readonly reason: string;
  /** ではどこでやるのか。 */
  readonly where: string;
  /**
   * コマンド文字列から検出するための断片。
   *
   * **basename で持つ**（`scripts/` を前置しない）。理由は 2 つ:
   *
   * 1. 呼び出し方が `./scripts/x.sh` / `bash scripts/x.sh` / コピーされた別パスと揺れても
   *    止めたい。安全側のガードなので、精度より取りこぼさない方を採る。
   * 2. `scripts/check-script-wiring.ts` は `scripts/<name>` という**文字列の出現**を
   *    「そのスクリプトが呼ばれている」と数える。ここは**止める対象として名前を書いている**
   *    だけで呼んではいないが、パスで書くと呼び出しと区別できず、manual-only の記録
   *    （なぜ手動か）が「もう自動配線された」と誤判定されて消える。
   */
  readonly matches: readonly string[];
}

export type LaneVerdict =
  | { readonly lane: 'cloud-eligible' }
  | { readonly lane: 'local-required'; readonly rule: LaneRule };

/**
 * ローカル限定の作業。**理由と代替手段を書けないものは載せない。**
 *
 * 現在 1 件しかないのは「絞った結果」であって、書き忘れではない（上の docblock 参照）。
 */
export const LOCAL_REQUIRED_RULES: readonly LaneRule[] = [
  {
    id: 'sts-credentials',
    reason:
      '短命 STS 資格情報の発行はローカル Mac の Admin 環境でだけ意味を持ち、出力に資格情報そのものを含む。' +
      'クラウドセッションで走らせると、失敗するだけでなく、失敗までに出した値が使い捨て VM の記録に残りうる',
    where:
      // パスを `scripts/…` の形で書かない理由は LaneRule.matches の docblock 参照
      // （配線検査が「呼んでいる」と数え、manual-only の記録を消してしまう）。
      'ローカル macOS のリポジトリで `aws-issue-credentials.sh`（`scripts/` 配下）を実行し、' +
      '得た短命 credential を環境変数としてクラウドへ渡す（docs/runbook-cloud-aws-deploy.md）',
    matches: ['aws-issue-credentials.sh'],
  },
];

/**
 * コマンド文字列をレーンへ分類する。
 *
 * **呼び出し側は引用符を落としてから渡すこと。** `guard-destructive.sh` の `scan` が
 * その形（`echo "... aws-issue-credentials.sh ..."` のような言及で止めないため）。
 * ここでその処理をしないのは、bash 側が既に持っている前処理を二重化しないため。
 */
export function classifyCommand(command: string): LaneVerdict {
  for (const rule of LOCAL_REQUIRED_RULES) {
    if (rule.matches.some((needle) => command.includes(needle))) {
      return { lane: 'local-required', rule };
    }
  }
  return { lane: 'cloud-eligible' };
}

/**
 * local privileged lane（＝ユーザーの macOS）で走っているか。
 *
 * **これは「クラウドかどうか」の近似である。** クラウドセッションは Ubuntu 24.04 なので
 * platform で見分けられるが、Linux のローカル開発機があれば誤って止める。
 * 本リポジトリのローカルは macOS だけ（`CLAUDE.md` の環境節）なので、この近似で足りる。
 */
export function runsOnLocalPrivilegedHost(platform: string): boolean {
  return platform === 'darwin';
}

/** ここで止めるべきか。**cloud-eligible はどこでも止めない。** */
export function shouldBlockHere(verdict: LaneVerdict, platform: string): boolean {
  return verdict.lane === 'local-required' && !runsOnLocalPrivilegedHost(platform);
}

/**
 * 止めた理由を人間向けに組み立てる。
 *
 * **「ではどこでやるのか」を必ず含める。** 代替手段の無いブロックは、次の周回で迂回されるか、
 * 意味を失って残る（このリポジトリは「解決手段のない指摘で恒久的に赤くなる」罠を
 * FAIL / SKIP / orphan で 3 度踏んでいる）。
 */
export function describeLaneBlock(rule: LaneRule): string {
  return (
    `この作業はローカル限定です（#675 / rule: ${rule.id}）。\n` +
    `理由: ${rule.reason}\n` +
    `どこでやるか: ${rule.where}`
  );
}
