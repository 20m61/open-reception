/**
 * Negative security test の判定 (spec §7)。
 *
 * `scripts/aws-negative-tests.ts` は AWS 認証情報が無いと動かず、本サイクルでは
 * 一度も実走しない。実走しないコードをテスト無しで置かないため、判定部分を
 * 純関数として切り出す。副作用（`aws` CLI の呼び出し）は一切持たない。
 */

export type Outcome = 'allowed' | 'denied' | 'unknown';

/** 拒否シグナル。大小文字を無視する。 */
const DENY_PATTERN = /AccessDenied|not authorized|explicit deny/i;

/**
 * `aws` CLI の stderr を判定する。**「対象アクションを直接実試行した」呼び出し
 * （`aws()` = N2/N3/N4/N5/N6/N7）専用。** ここでの AccessDenied は「試した操作そのもの」が
 * denied だったことを意味する。
 *
 * **`unknown` は「まだ確認していない」を表す。denied を推測で埋めない。**
 * 空文字列は `DENY_PATTERN` のどの分岐にも一致しないため自然に `unknown` になる
 * （明示的な早期リターンは無くてもよい。[[空文字は「問題なし」ではない]] の性質は
 * 下のテストが regex 経由で固定する）。拒否シグナルを含まない他のエラー
 * （ネットワーク断・スロットリング等）も同様に `unknown` に落ちる。判定材料が無いことを
 * 都合よく「denied だった」に読み替えない。
 *
 * 🔴 **`simulate()`（`iam:SimulatePrincipalPolicy` の呼び出し）の catch には使わない。**
 * そちらは `classifySimulationError` を使う（意味が違う。理由は下記コメント参照）。
 */
export function classifyAwsError(stderr: string): 'denied' | 'unknown' {
  return DENY_PATTERN.test(stderr) ? 'denied' : 'unknown';
}

/**
 * `simulate()`（`iam:SimulatePrincipalPolicy` の呼び出し）が例外を投げたときの判定。
 *
 * 🔴 **CRITICAL: `classifyAwsError` を流用しない。** `aws()` では「呼び出し自体が
 * AccessDenied」＝「試した操作（対象アクション）が denied」だが、`simulate()` の例外は
 * 「`SimulatePrincipalPolicy` という**別の** API 呼び出しができなかった」だけであり、
 * 評価対象のアクション（例: `dynamodb:DeleteTable`）が denied かどうかについて
 * **何も語らない**。ここで `classifyAwsError(stderr)` を呼ぶと、
 * `SimulatePrincipalPolicy` 自体への AccessDenied（＝評価不能）が「対象アクションは
 * denied だった」に化けてしまい、`iam:SimulatePrincipalPolicy` 権限を持たない
 * principal で実行すると S1〜S10 が**すべて見かけ上 PASS**になる
 * （2026-08-12 レビューで発見された CRITICAL）。
 *
 * 常に `'unknown'` を返す。stderr の中身に関わらず、である。
 */
export function classifySimulationError(_stderr: string): 'unknown' {
  return 'unknown';
}

/**
 * S 系（`iam:SimulatePrincipalPolicy`）を評価する対象の principal (spec §7 / Critical 3)。
 *
 * 🔴 **なぜ「1 本の principal ARN」ではいけないか。** 旧実装は `principalArn` を 1 つだけ
 * 受け取り、既定を `OpenReceptionClaudeDeploy-dev`（entry role）にしていた。entry role は
 * `DenyEverythingElseOutsideTheChain` により 4 アクション以外を最初から全 Deny するので、
 * **S1〜S11 は `claude-boundary.json` と `claude-cfn-exec.json` が存在するかどうかに関係なく
 * すべて `denied` を返す** —— つまり「絶対に落ちない検査」だった。
 * S4/S5/S7（boundary 脱出）や S6（PassRole）が意味を持つのは
 * `cdk-orcloud01-cfn-exec-role-*` に対してだけであり、その principal は本ブランチのどこでも
 * 一度もシミュレートされていなかった。ADR はこの検査群を初回デプロイの前提条件と呼んでいる。
 *
 * よって check ごとに「どのロールに対して評価すべきか」を型で持たせ、
 * ARN が供給されていなければ**実行を拒否する**（既定でごまかさない）。
 */
export type SimulationPrincipal = 'entry' | 'deploy' | 'exec';

export const SIMULATION_PRINCIPALS: ReadonlyArray<SimulationPrincipal> = ['entry', 'deploy', 'exec'];

/**
 * S 系を評価するリージョン (#680 R4)。
 *
 * 🔴 **なぜ region が型に要るか。** 旧実装は `SIMULATED_CHECKS` のリソース ARN を
 * すべて `ap-northeast-1` にハードコードし、principal ARN も 1 region 分しか
 * 受け取らなかった。runbook ステップ 4a は「us-east-1 側も `-us-east-1` 版で 1 度
 * 実行する」と指示していたが、それで変わるのは `--policy-source-arn` だけで、
 * **評価されるリソースは ap-northeast-1 のまま**である。つまり運用者は
 * 「us-east-1 を検証した」と記録するのに、us-east-1 のリソースは一度も
 * シミュレートされていなかった。ステップ 4 は初回デプロイを認可するゲートなので、
 * ここでの偽 PASS は本ブランチが繰り返し踏んでいる欠陥そのものである。
 */
export type SimulationRegion = 'ap-northeast-1' | 'us-east-1';

export const SIMULATION_REGIONS: ReadonlyArray<SimulationRegion> = ['ap-northeast-1', 'us-east-1'];

/**
 * その principal は region ごとに別のロールか。
 *
 * `entry`（`OpenReceptionClaudeDeploy-dev`）は IAM ロールなのでグローバルに 1 本。
 * `deploy` / `exec` は CDK bootstrap が region ごとに作る
 * （`cdk-orcloud01-{deploy,cfn-exec}-role-<account>-<region>`）ので別物であり、
 * **片方だけ検証しても、もう片方が同じポリシーで bootstrap された保証は無い**。
 */
export function isRegionalPrincipal(principal: SimulationPrincipal): boolean {
  return principal !== 'entry';
}

/** principal（＋ region）を一意に指す鍵。 */
export function principalArnKey(principal: SimulationPrincipal, region: SimulationRegion): string {
  return isRegionalPrincipal(principal) ? `${principal}@${region}` : principal;
}

/** 鍵 → 実在の IAM ロール ARN。**既定値を持たない**（供給されなければ実行しない）。 */
export type PrincipalArnMap = Readonly<Record<string, string | undefined>>;

const supplied = (arn: string | undefined): boolean => typeof arn === 'string' && arn.trim() !== '';

/**
 * 供給されていない（または空文字の）鍵を、重複を除いて宣言順で返す。
 *
 * 空文字を「供給された」と読まない ―― `SIMULATE_EXEC_ROLE_ARN_US_EAST_1=` のような
 * 未展開の環境変数は「判定不能」であって「問題なし」ではない
 * （[[空文字は「問題なし」ではない]] と同じ型の穴）。
 */
export function findUnsuppliedPrincipalKeys(
  required: ReadonlyArray<string>,
  arns: PrincipalArnMap,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const key of required) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!supplied(arns[key])) missing.push(key);
  }
  return missing;
}

/** 供給されていれば ARN を、されていなければ `null` を返す。 */
export function resolvePrincipalArnByKey(key: string, arns: PrincipalArnMap): string | null {
  const arn = arns[key];
  return supplied(arn) ? arn!.trim() : null;
}

/**
 * その check をどの region で評価するか (#680 R4)。
 *
 * 🔴 **`only` には理由を必ず書かせる。** 「us-east-1 では評価していない」ことを
 * 黙って落とすと、運用者は全件 PASS を「両 region で検証済み」と読む。
 * 型で理由を要求し、実行時に結果行へ印字することで、**覆っていない範囲が
 * 出力に現れる**ようにする。
 */
export type RegionCoverage =
  | { readonly kind: 'both' }
  | { readonly kind: 'only'; readonly region: SimulationRegion; readonly reason: string };

/** 評価対象の region を返す。 */
export function coveredRegions(coverage: RegionCoverage): ReadonlyArray<SimulationRegion> {
  return coverage.kind === 'both' ? SIMULATION_REGIONS : [coverage.region];
}

/** 覆っていない region と、その理由（出力に載せる）。無ければ `null`。 */
export function uncoveredRegionNote(coverage: RegionCoverage): string | null {
  if (coverage.kind === 'both') return null;
  const skipped = SIMULATION_REGIONS.filter((r) => r !== coverage.region);
  return `${skipped.join(' / ')} は未評価: ${coverage.reason}`;
}

export type NegativeTestResult = {
  readonly id: string;
  readonly expected: 'allowed' | 'denied';
  readonly actual: Outcome;
  /**
   * S 系のみ。**評価すべき** principal の ARN。live check（N 系）では省略する。
   */
  readonly requiredPrincipalArn?: string;
  /**
   * S 系のみ。**実際に評価した** principal の ARN。
   * `requiredPrincipalArn` と食い違うものは、結果を採点せず**棄却**する。
   */
  readonly evaluatedPrincipalArn?: string;
};

export type NegativeTestSummary = {
  readonly failed: number;
  /** 誤った principal に対して評価されたため採点しなかった件数（`failed` にも含む）。 */
  readonly misdirected: number;
};

/**
 * 意図した principal に対して評価されたか。
 *
 * `requiredPrincipalArn` を持つ結果（S 系）は、`evaluatedPrincipalArn` が一致しなければ
 * **結果の内容に関わらず無効**である。「denied だったから PASS」と数えてしまうと、
 * Critical 3 で見つかった「entry role に対して boundary 脱出を聞いていた」状態を
 * そのまま再現する。
 */
function isMisdirected(r: NegativeTestResult): boolean {
  if (r.requiredPrincipalArn === undefined) return false;
  return r.evaluatedPrincipalArn !== r.requiredPrincipalArn;
}

/**
 * `actual === expected` の完全一致でのみ PASS とする。
 *
 * **`unknown` は決して PASS にならない**: `expected` が `'denied'` でも `'allowed'` でも、
 * `actual` が `'unknown'` なら不一致として failed に数える。判定不能を PASS に丸めると、
 * 実は Deny が効いていないケースを見逃す（`--strict` の思想と同じ: 測れていないものを
 * PASS にしない）。
 *
 * **誤った principal に対する評価も PASS にしない**（採点せず棄却して failed に数える）。
 */
export function summarizeNegativeTests(results: ReadonlyArray<NegativeTestResult>): NegativeTestSummary {
  const misdirected = results.filter(isMisdirected).length;
  const failed = results.filter((r) => isMisdirected(r) || r.actual !== r.expected).length;
  return { failed, misdirected };
}

export type ExecutionScope = 'live' | 'simulate' | 'all';

/**
 * `--live-only` / `--simulate-only` の相互排他を判定する (spec §7 / Important 5b)。
 *
 * S 系（`SimulatePrincipalPolicy`）は `iam:SimulatePrincipalPolicy` 権限を持つ
 * 人間の Admin 環境からの runbook 実行を前提とする。`OpenReceptionClaudeDeploy-dev`
 * にその権限を与えるべきではないため、`scripts/aws-cloud-deploy.sh` の
 * `collect_observation` は常に `--live-only` を渡し、S 系はスキップする。
 *
 * 両方同時指定は矛盾する要求（「live だけ」と「simulate だけ」を同時に言っている）
 * なので `null` を返し、呼び出し側に非ゼロ終了させる。
 */
export function resolveExecutionScope(simulateOnly: boolean, liveOnly: boolean): ExecutionScope | null {
  if (simulateOnly && liveOnly) return null;
  if (simulateOnly) return 'simulate';
  if (liveOnly) return 'live';
  return 'all';
}

/**
 * probe の仕組み: 「シミュレーション不能」を自動測定する (#680 フォローアップ / defect 2)。
 *
 * `S16`（`cloudformation:DescribeChangeSet` を changeSet ARN に対して評価し
 * `expected: 'allowed'`）が `implicitDeny` を返し続けた（2026-08-13、`simulate-custom-policy`
 * で単離）:
 *
 * | 呼び出し | 結果 |
 * | --- | --- |
 * | `DescribeChangeSet`, リソース ARN 無し | `allowed`（アクション自体は認識される） |
 * | `DescribeStacks`, stack ARN, `Resource: "*"` | `allowed`（stack 型は機能する） |
 * | `DescribeChangeSet`, changeSet ARN, `Resource: "*"` | `implicitDeny`（最小 Allow でも！） |
 * | `ExecuteChangeSet`, changeSet ARN, `Resource: "*"` | `implicitDeny`（同上） |
 *
 * 当初はこれを「IAM のポリシーシミュレータが CloudFormation の `changeset` リソース種別を
 * 評価できない」という**道具側の限界**と解釈した。
 *
 * 🔴 **この解釈は誤りだった（2026-08-13、`cdk deploy --no-execute` の実 API 実測で訂正）。**
 * 実際の `AccessDenied` は `resource: arn:...:stack/OpenReception-Web-dev/<id>` ――
 * **stack ARN** を名指しした。`DescribeChangeSet` は changeSet ARN ではなく stack ARN に
 * 対して認可される。つまり上表の `implicitDeny` は、シミュレータが評価できていないのでは
 * なく、**「changeSet ARN スコープの Allow では `DescribeChangeSet` は本来一致し得ない」**
 * という正しい答えを返していた。ポリシー側の設計が AWS Service Authorization Reference の
 * 読解に基づいて誤っていた（`ReadOwnChangeSetsForDiffGate` を changeSet ARN にスコープして
 * いた）ことが原因であり、`claude-deploy-entry.json` は `ReadOwnDevStacksForDiffGate` へ
 * `DescribeChangeSet` を統合する形へ訂正済み（詳細: ADR 0009 決定 2）。**S15/S16 とも
 * stack ARN を対象にした結果、もはやこの probe を発火させない。**
 *
 * 🔴 **それでもこの機構自体は汎用のまま残す。** 「落ちようのない検査」を作る側の欠陥は
 * このブランチが何度も踏んできた（Critical 3・R4）。**`expected: 'allowed'` の check が
 * `implicitDeny`（他の何にも一致しなかった）を返したときだけ**、最小 Allow による probe を
 * 打って「本当に評価できていないのか」を都度測る。教訓は「ドキュメントの読解ではなく
 * 実 API 応答で資源型を確認する」ことであり、`implicitDeny` を安易に道具の限界だと
 * 決め打たない ―― 今回のケースでは probe と当初の解釈がどちらも同じ誤読の上に立っていた。
 * AWS が将来 changeset リソース種別へ実際に対応する、または別のアクションで真にシミュレータが
 * 未対応な資源型に出会えば、probe が `allowed` を返すようになり、check は自動的に通常の
 * 採点へ戻る（`isUnexplainedImplicitDeny` → `classifyProbeVerdict` の合成）。
 */

/**
 * `iam:SimulatePrincipalPolicy` / `iam:SimulateCustomPolicy` が返す `EvalDecision` の生の値。
 *
 * AWS はこの 3 値しか返さない。旧実装は `endsWith('Deny')` で `explicitDeny` と
 * `implicitDeny` を一括りに `Outcome` の `'denied'` へ潰しており、
 * 「ポリシーが明示的に拒否した」ケースと「何にも一致しなかった」ケースを
 * 区別できなかった。probe を打つべきかどうかの判定にはこの区別が要る
 * （`implicitDeny` だけが「シミュレータ未対応」の兆候になり得る。`explicitDeny` は
 * 実際に一致するステートメントがあったことの証拠であり、シミュレータは機能している）。
 */
export type EvalDecision = 'allowed' | 'explicitDeny' | 'implicitDeny';

/**
 * `EvalDecision` の生テキストを解析する。3 値のどれとも一致しなければ `null`
 * （空文字・前後空白・想定外の文字列すべて含む）。`null` をどう扱うかは呼び出し側の
 * 責務 —— ここでは「denied 相当に丸める」ような親切をしない
 * （[[空文字は「問題なし」ではない]] と同じ理由）。
 */
export function parseEvalDecision(raw: string): EvalDecision | null {
  const trimmed = raw.trim();
  if (trimmed === 'allowed' || trimmed === 'explicitDeny' || trimmed === 'implicitDeny') return trimmed;
  return null;
}

/** `EvalDecision` を既存の粗い `Outcome` へ写像する。`explicitDeny`/`implicitDeny` はどちらも `'denied'`。 */
export function evalDecisionToOutcome(decision: EvalDecision | null): Outcome {
  if (decision === 'allowed') return 'allowed';
  if (decision === 'explicitDeny' || decision === 'implicitDeny') return 'denied';
  return 'unknown';
}

/**
 * probe（simulate-custom-policy による測定）を打つべきかどうか。
 *
 * 🔴 **これが「escape hatch にしない」ための唯一のゲートである。** 条件は 2 つとも
 * 満たす必要がある:
 *
 * 1. `expected === 'allowed'` —— `expected: 'denied'` の check にとって `implicitDeny`
 *    はまさに期待どおりの正当な PASS であり、シミュレータ未対応を疑う理由が無い
 * 2. `decision === 'implicitDeny'` —— 「他のどのステートメントにも一致しなかった」
 *    ことの直接的な兆候。`explicitDeny`（一致するステートメントがあった）や
 *    `allowed`（そのまま PASS）では probe を打つ意味が無い
 *
 * check の ID や resource の中身（`changeSet` を含むかどうか等）では判定しない。
 * ID で判定すると「新しい check が同じ限界にぶつかったときに気づけない」
 * ハードコードへ逆戻りする。
 */
export function isUnexplainedImplicitDeny(
  expected: 'allowed' | 'denied',
  decision: EvalDecision | null,
): boolean {
  return expected === 'allowed' && decision === 'implicitDeny';
}

/** probe の判定結果。 */
export type ProbeVerdict = 'unsimulatable' | 'supported';

/**
 * probe（`simulate-custom-policy` に action を `Resource: "*"` で Allow するだけの、
 * 評価対象 principal とは無関係な最小ポリシーを渡し、同じ resource ARN に対して評価
 * させたもの）の結果を解釈する。
 *
 * 🔴 **`'unsimulatable'` を返すのは `probeDecision === 'implicitDeny'` のときだけ。**
 * 最小限の Allow ですら一致しないなら、principal のポリシーの中身に関係なく
 * 評価できていない ―― シミュレータがこのリソース種別を認識していないという直接証拠になる。
 *
 * それ以外は全部 `'supported'`（`allowed` はもちろん、`explicitDeny` や、probe 自体が
 * 例外を投げて呼び出し側が `null` を渡してきた場合も含む）。
 * **`'supported'` は「シミュレータは機能している」ことを意味し、元の check は
 * 通常どおり FAIL として採点される。** probe が失敗した（`null`）ケースを
 * `'unsimulatable'` 側へ倒すと、「probe 自体が呼べなかった」という別の障害が
 * 「シミュレータの限界」にすり替わり、本物の権限不足を隠す一般的な逃げ道になる
 * （要件: 判定不能を都合よく読み替えない。`unknown` は FAIL のまま）。
 */
export function classifyProbeVerdict(probeDecision: EvalDecision | null): ProbeVerdict {
  return probeDecision === 'implicitDeny' ? 'unsimulatable' : 'supported';
}
