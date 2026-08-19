/**
 * 変更リスクの機械判定 (issue #424 増分 3)。
 *
 * `CLAUDE.md` の重大変更条件・`.claude/rules/opus5-autonomous-loop.md` の停止境界・
 * `docs/ai-development-loop.md` §6 が列挙する「人間承認なしで進めない変更」は、これまで
 * **人間か AI が覚えていて自分で判定する**規律だった。1 周ごとに手で判定するので、忘れれば
 * そのまま素通りする。判定を変更パスから導出して、少なくとも**見落としが検出される**形にする。
 *
 * 設計原則:
 *  - 副作用なし（I/O・git・DOM 非依存）。変更パスと追加依存名を**受け取る**だけで、自分で
 *    `git diff` を叩かない（呼び出し側が渡す。純関数のままテストできる）。
 *  - PII を扱わない。
 *
 * **これは検出器であって判定者ではない。** パスから分かるのは「その変更が境界を運びうる領域に
 * 触れた」ことまでで、「実際に破壊的か」は分からない（`src/app/api/**` の追加は非破壊でも
 * 当たる）。だから偽陽性に倒す: **偽陽性は人が一目で流せるが、偽陰性は境界を素通りさせる。**
 * 「承認が要る」と出たら人が見る、が正しい使い方で、「要らない」と出たことを免罪符にしない。
 */

/**
 * 停止境界。`docs/ai-development-loop.md` §6 の列挙と 1:1 に対応させる
 * （語彙だけ増やして検出器を書き忘れないよう `change-risk.test.ts` のメタテストで縛る）。
 */
export const CHANGE_BOUNDARIES = [
  'productionDeploy', // 本番デプロイ / 本番データ操作
  'authBoundary', // 認証・認可・PIN/IP 制御の境界
  'persistenceOrPublicApi', // 永続スキーマ・公開 API
  'externalTransmission', // 新しい外部送信
  'secretOrPii', // secret / PII / 監査ログ方針
  'dependency', // 新規依存・ライセンス判断 (#105)
  'recurringCost', // 継続的な費用増
  'journeyOrStateModel', // 主要 Journey / state / fallback の意味
] as const;

export type ChangeBoundary = (typeof CHANGE_BOUNDARIES)[number];

/** 判定の入力。呼び出し側が `collectChangedPaths`（`git-base.ts`）等から組み立てる。 */
export type ChangeSignals = {
  /** 変更ファイルのリポジトリ相対パス。 */
  paths: ReadonlyArray<string>;
  /**
   * 追加された依存名（`package.json` の diff から呼び出し側が抽出する）。
   * 渡さなくても `package.json` の変更自体は `dependency` に当たる（版上げも #105 の対象）。
   */
  addedDependencies?: ReadonlyArray<string>;
  /**
   * 変更パスの収集が**完了したか**の申告 (#709)。
   *
   * `git diff` / `git status` は環境で失敗しうる。失敗を空文字に落とすと、呼び出し側は
   * 「変更 0 件」と区別できず、この関数は「停止境界に触れていません（人間承認は不要）」を
   * 返してしまう —— **測れていないのに安全宣言をする**。report-only なのでゲートは
   * 赤くならず、レビューは「機械が触れていないと言った」を根拠にしかねない。
   *
   * 省略時は `paths` と `addedDependencies` の**両方が空なら未測定**と読む
   * （`change-scope.ts` の「変更ゼロは収集失敗の可能性がある」と同じ倒し方）。
   */
  measurement?: MeasurementState;
};

/** 変更パスを集めきれたか。 */
export type MeasurementState = 'complete' | 'incomplete';

/** 当たった境界と、その根拠（人が確認できないと判定を信用できない）。 */
export type BoundaryHit = {
  boundary: ChangeBoundary;
  evidence: ReadonlyArray<string>;
};

export type ChangeRiskAssessment = {
  /** 当たった境界。`CHANGE_BOUNDARIES` の順に並ぶ（出力の順序を安定させる）。 */
  hits: ReadonlyArray<BoundaryHit>;
  /**
   * 1 つでも当たれば true。**判定不能（`assessable === false`）のときも true** ——
   * 測れていないものを「承認不要」と言わない (#709)。
   */
  requiresHumanApproval: boolean;
  /**
   * 判定が成立したか (#709)。
   *
   * `false` のとき、`hits` が空でも「境界に触れていない」を意味しない（測れなかっただけ）。
   * **`hits.length === 0` を「安全」と読み替える前に、必ずここを見ること。**
   */
  assessable: boolean;
};

/**
 * 境界ごとのパス検出規則。
 *
 * **テストファイルを除外しない。** 認可テストの書き換えは「正当な追加」と「ガードの弱体化」が
 * 同じ形をしていて、パスからは区別できない（`.claude/rules/opus5-autonomous-loop.md`
 * 「テスト削除、skip、弱体化で green にしない」）。区別せず人へ回す。
 */
const BOUNDARY_PATTERNS: Record<ChangeBoundary, ReadonlyArray<RegExp>> = {
  // CDK は本番スタックの形を変える。deploy そのものは手動でも、定義変更は承認対象。
  productionDeploy: [/^infra\//],
  authBoundary: [
    /^src\/domain\/tenant\/authorization\./, // 認可の純関数（真実源）
    /^src\/domain\/auth\//,
    /^src\/lib\/auth\//,
    /^src\/app\/api\/.*\/authorize\//, // 端末 PIN 自己許可など
    /^src\/lib\/platform\/elevation-/, // 権限昇格
    /^middleware\.ts$/, // 経路全体のガード
  ],
  persistenceOrPublicApi: [
    /^src\/lib\/data-stores\//, // DynamoDB ストア
    /(^|\/)[^/]*-store\.ts$/, // 各ドメインの永続層
    /(^|\/)[^/]*-repository\.ts$/,
    /^src\/app\/api\/.*\/route\.ts$/, // 公開 API の表面
  ],
  externalTransmission: [
    /(^|\/)vonage-/, // 電話
    /(^|\/)polly-/, // 音声合成
    /(^|\/)transcribe-/, // 音声認識
    /(^|\/)[^/]*-adapter\.ts$/, // 外部サービスのアダプタ全般
  ],
  secretOrPii: [
    /^src\/domain\/provider-config\/secret\./,
    /(^|\/)tenant-secret-store\./,
    /^src\/domain\/reception\/log\./, // AuditAction / 監査に残す範囲
    /^src\/domain\/audit\//,
    /(^|\/)secrets-manager-/,
  ],
  // **lockfile で判定する。** `package.json` はスクリプト追加のような依存と無関係の編集でも
  // 変わるので、それで当てると毎回出る警告になり読まれなくなる（ドッグフーディングで実際に
  // 出た）。依存木が動いたかは lockfile が判別でき、npm は両者を同期させる。
  // `package.json` 側だけで依存が増えたケースは `addedDependencies` が拾う（下の追記規則）。
  dependency: [/^package-lock\.json$/, /^infra\/package-lock\.json$/],
  // 継続費用が変わるのは常設リソースの定義。deploy 済みかは別問題なので定義変更で当てる。
  recurringCost: [/^infra\/lib\/stacks\//, /^infra\/lib\/constructs\//],
  journeyOrStateModel: [
    /^src\/domain\/reception\/state\./, // 受付の遷移表
    /^src\/domain\/checkin\/state\./, // QR 受付の遷移表
    /^src\/domain\/reception\/ui-contract\./, // 表示契約（answers/escape/inputModes 等）
    /^src\/domain\/experience\//, // Journey と実装の対応
    /^docs\/experience\//, // 体験設計の正本
  ],
};

/**
 * 変更パスから、触れた停止境界を導出する。
 *
 * 同じ境界に複数のパスが当たったら 1 件にまとめ、根拠は**全部**残す（どれで当たったか
 * 分からないと人が確認できない）。根拠の順序は入力パスの順序を保つ。
 */
export function classifyChangeRisk(signals: ChangeSignals): ChangeRiskAssessment {
  const hits: BoundaryHit[] = [];
  for (const boundary of CHANGE_BOUNDARIES) {
    const patterns = BOUNDARY_PATTERNS[boundary];
    const evidence = signals.paths.filter((path) => patterns.some((re) => re.test(path)));
    // 追加依存名は `dependency` の根拠に足す（何が増えたかが判断の要点）。lockfile が
    // 変わっていなくても**依存名が増えているなら当てる**（パスだけに頼らない）。
    const added = boundary === 'dependency' ? (signals.addedDependencies ?? []) : [];
    if (evidence.length === 0 && added.length === 0) continue;
    hits.push({ boundary, evidence: [...evidence, ...added] });
  }
  // **測れたかどうかを、当たったかどうかより先に決める** (#709)。
  const assessable = resolveMeasurement(signals) === 'complete';
  return { hits, requiresHumanApproval: hits.length > 0 || !assessable, assessable };
}

/**
 * 収集が完了したかを決める (#709)。
 *
 * 申告があればそれに従う。無いときは「入力が空＝収集に失敗した可能性がある」と読む。
 * ただし**依存名が採れているなら測れている**（マニフェストは読めている）ので、パスが
 * 空でも未測定とは限らない。
 */
function resolveMeasurement(signals: ChangeSignals): MeasurementState {
  if (signals.measurement !== undefined) return signals.measurement;
  const nothingCollected =
    signals.paths.length === 0 && (signals.addedDependencies ?? []).length === 0;
  return nothingCollected ? 'incomplete' : 'complete';
}

/** `package.json` の依存フィールド（欠けていてよい）。 */
export type DependencyManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** ライセンス判断（#105）の対象になる依存フィールド。dev 依存も対象に含める。 */
const DEPENDENCY_FIELDS: ReadonlyArray<keyof DependencyManifest> = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

function dependencyNames(manifest: DependencyManifest): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

/**
 * base → head で**新しく増えた**依存名を返す。
 *
 * 版だけ変わったものは含めない。#105 のライセンス/プライバシーチェックが要るのは
 * 「今まで持っていなかったコードを取り込むこと」なので、版上げとは判断の重さが違う
 * （版上げ自体は `dependency` 境界に当たるので、承認判定からは漏れない）。
 */
export function addedDependencyNames(
  base: DependencyManifest,
  head: DependencyManifest,
): ReadonlyArray<string> {
  const before = dependencyNames(base);
  return [...dependencyNames(head)].filter((name) => !before.has(name));
}
