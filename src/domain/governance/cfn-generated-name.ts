/**
 * CloudFormation が生成する物理名の予測と、IAM のリソース ARN グロブ照合 (#680 R1/R2/R3)。
 *
 * 副作用なし。**なぜ純関数として要るのか**:
 *
 * CDK の `CustomResourceProvider`（`crossRegionReferences` / `autoDeleteObjects`）は
 * 生の `AWS::IAM::Role` を吐く。`RoleName` を指定しないので、物理名は
 * CloudFormation が `<スタック名>-<論理 ID>-<12 文字の乱数>` として生成し、
 * IAM ロール名の上限 64 文字に収まるよう**論理 ID を左から切り詰める**。
 *
 * この切り詰めが carve-out の設計を決める。論理 ID には
 * `CustomResourceProviderRole` という文字列が必ず含まれるのに、**物理名には残らない**
 * ―― スタック名が長いほど早く落ちるからである。実在する 2 本
 * （`OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw` /
 * `OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-yIrNw85NvcWP`）が
 * どちらもちょうど 64 文字で、どちらも `CustomResourceProviderRole` を含まないのが証拠。
 * 「論理 ID で通ると思って書いた ARN パターン」は**一致せず、初回デプロイで
 * AccessDenied → ROLLBACK_FAILED になる**。だから予測を関数にしてテストで固定する。
 */

/**
 * `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` / `PassRole` を
 * Permissions Boundary 条件・タグ条件から除外している ARN パターン (#680 R2/R3)。
 *
 * 🔴 **これは「取りうる最も狭いパターン」ではない。** 2 本に分ければ
 * （`…-CustomCrossRegion*` ＋ `…-CustomS3AutoDelete*`）より狭く、`claude-boundary.json` の
 * 残り文字数にも収まる。それでも 1 本にしてあるのは、**どのみち名前グロブでは
 * 敵対的なテンプレートを防げないから**である —— 論理 ID はテンプレートを書く側が
 * 決められ、切り詰めによって `CustomResourceProviderRole` のような区別できる
 * サフィックスは物理名から消える（上のコメント）。狭さが買えるのは
 * **事故耐性だけで、敵対的なテンプレートに対する耐性ではない**。
 *
 * 敵対的なテンプレートを止めるのは `deploy-diff-gate.ts` の
 * `carveOutRoleNamespace` / `carveOutRoleShape`（論理 ID の allowlist ＋ 形の固定）であって、
 * このパターンではない。
 *
 * 出荷している `scripts/aws-policies/claude-cfn-exec.json` /
 * `claude-boundary.json` と一致していることは `aws-policy-shape.test.ts` が固定する。
 */
/**
 * 🔴 **`-dev-` を要求できるのは、スタック名が 25 文字以内のときだけ（2026-08-15 の実測）。**
 *
 * CloudFormation は**スタック名も切り詰める**。旧 `OpenReception-CfMonitoring-dev`(30) は
 * `OpenReception-CfMonitorin` になり **`-dev` が消え**、このパターンに一致せず
 * `iam:CreateRole` が Deny されてスタック作成が失敗した。
 *
 * パターンを広げて `-dev-` を落とすと、prod / staging を除外できなくなる
 * （切り詰めで環境名が消えるため、名前だけでは区別できない）。したがって
 * **スタック名側を短くする**方を選び、`OpenReception-CfMon-dev`(23) へ改名した。
 * `cfn-generated-name.test.ts` の「新スタック名は切り詰められず -dev が残る」が
 * この前提を固定している ―― 25 文字を超えた瞬間に赤くなる。
 */
export const CARVE_OUT_ROLE_ARN_PATTERN = 'arn:aws:iam::822063948773:role/OpenReception-*-dev-Custom*';

/**
 * carve-out パターンが属するアカウント ID。**パターンから取り出す**（別に書き写さない）。
 * 二重管理すると「ポリシーは A、gate は B」というずれが黙って生まれる。
 */
export const CARVE_OUT_ACCOUNT_ID = ((): string => {
  const m = /^arn:aws:iam::(\d{12}):role\//.exec(CARVE_OUT_ROLE_ARN_PATTERN);
  if (m?.[1] === undefined) {
    throw new Error(
      `carve-out パターンからアカウント ID を取り出せません: ${CARVE_OUT_ROLE_ARN_PATTERN}`,
    );
  }
  return m[1];
})();

/** IAM ロール名の上限。 */
export const IAM_ROLE_NAME_MAX_LENGTH = 64;

/** CloudFormation が付ける乱数サフィックスの長さ（実在名 2 本から確認）。 */
export const CFN_GENERATED_NAME_SUFFIX_LENGTH = 12;

export type GeneratedNameOptions = {
  readonly maxLength?: number;
  readonly suffixLength?: number;
};

/**
 * CloudFormation が生成する物理名の、**乱数サフィックスを除いた確定部分**を返す
 * （末尾のハイフンまでを含む）。
 *
 * 予算が 1 文字も残らない場合は throw する。**空文字を返して「一致しました」に
 * 落とさない** ―― 判定不能を素通りさせると carve-out が空振りしていることに
 * 誰も気づけない。
 */
export function cfnGeneratedNamePrefix(
  stackName: string,
  logicalId: string,
  options: GeneratedNameOptions = {},
): string {
  const maxLength = options.maxLength ?? IAM_ROLE_NAME_MAX_LENGTH;
  const suffixLength = options.suffixLength ?? CFN_GENERATED_NAME_SUFFIX_LENGTH;
  // `<stack>` + `-` + `<logicalId>` + `-` + `<suffix>` で maxLength に収める。
  const budget = maxLength - 2 - suffixLength;
  if (budget <= 1) {
    throw new Error(
      `物理名の予算が足りません: maxLength=${maxLength}, suffixLength=${suffixLength}`,
    );
  }

  // 🔴 **スタック名も切られる（2026-08-15 の実測）。**
  // 旧実装は「切られるのは論理 ID だけ」と仮定していたが、
  // `OpenReception-CfMon-dev`(30) は実際には 25 文字へ切られていた。
  // 予算を半分ずつ配り、**半分を超えた側だけ**切る。使われなかった余りは相手へ回る。
  //   64 - 12 - 2 = 50 → 各 25
  //   OpenReception-Web-dev(21)          → 無傷。論理 ID の取り分は 50 - 21 = 29
  //   旧 OpenReception-CfMonitoring-dev(30) → 25 へ切断。論理 ID の取り分は 25
  const half = Math.floor(budget / 2);
  const stackPart = stackName.length <= half ? stackName : stackName.slice(0, half);
  const logicalBudget = budget - stackPart.length;
  return `${stackPart}-${logicalId.slice(0, logicalBudget)}-`;
}

/**
 * 🔴 **動的 `RegExp` で組み立てない。** 以前は `iamArnGlobMatches` がグロブ 1 文字ずつを
 * 正規表現ソースへ変換し `new RegExp(...)` していた（`.*` は 0 文字以上、`?` は `.` ）。
 * semgrep の `detect-non-literal-regexp`（ReDoS 監査）が指す通り、パターンが動的な
 * `RegExp()` の引数になっていること自体が疑わしい形であり、加えて実際の意味も
 * ズレていた —— JS の `.` は `s` フラグなしでは `\n` に一致しないが、下の NFA は
 * `*` を任意の 1 文字として扱う。IAM のリソース ARN グロブは正規表現ではなく
 * 文字クラス的な意味（`*` に改行の例外はない）なので、NFA 側が本来の意味に近い。
 * `iamArnGlobMatches` は今は下の `globNfaMatches` へ全文字を `literal` として渡す
 * だけの薄いラッパーになっている（動的 RegExp を経由しない）。
 *
 * （旧 `globCharToRegexSource` は番兵文字を使わない実装にしてあった。以前は `*` を
 * いったん `\0STAR\0` へ置換してから戻す実装で、動きはするがソースに NUL バイトが
 * 入るため ripgrep がこのファイルを binary と見なして走査対象から外す ——
 * `CLAUDE.md`「調査の作法」が繰り返し戒めている「その条件では見つからなかっただけ」を
 * ファイル単位で起こす、という理由で番兵無しに書き直された。動的 RegExp 自体を
 * 廃止した今もその教訓は当てはまる箇所があるかもしれないので、ここに残す。）
 */

/** CloudFormation の乱数サフィックスに現れる文字。 */
const CFN_SUFFIX_ALPHABET = /[A-Za-z0-9]/;

/** グロブ照合における値側の 1 文字。未確定の乱数サフィックスは「英数字のどれか」。 */
type GlobValueChar = { readonly kind: 'literal'; readonly ch: string } | { readonly kind: 'alnum' };

/**
 * グロブを NFA として走らせる。**バックトラックではなく到達集合**で持つ
 * （値側に「英数字のどれか」という未確定の文字が混ざるため、素朴な貪欲照合では
 * 分岐を取りこぼす）。
 *
 * `*` は改行を含む任意の 1 文字に一致する（正規表現の `.` と違い、`s` フラグ相当の
 * 例外を持たない）。IAM のリソース ARN グロブ照合に「改行だけは特別」という規則は
 * ない —— ここを狭めると、値に改行を含む細工で carve-out の判定をすり抜けさせ、
 * `resolvePolicyRoleTarget`（`deploy-diff-gate.ts`）が本来 `carveOut` へ分類して
 * 掛けるはずの追加検査（`carveOutRoleShape`）を skip させてしまう（fail-open）。
 */
function globNfaMatches(pattern: string, value: ReadonlyArray<GlobValueChar>): boolean {
  const closure = (seed: Iterable<number>): Set<number> => {
    const out = new Set<number>();
    const stack = [...seed];
    for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
      if (out.has(p)) continue;
      out.add(p);
      // `*` は空文字にも一致する。
      if (pattern[p] === '*') stack.push(p + 1);
    }
    return out;
  };

  let current = closure([0]);
  for (const vc of value) {
    const next = new Set<number>();
    for (const p of current) {
      const pc = pattern[p];
      if (pc === undefined) continue;
      if (pc === '*') {
        next.add(p); // 1 文字吸って留まる
        continue;
      }
      if (pc === '?') {
        next.add(p + 1);
        continue;
      }
      const matches = vc.kind === 'literal' ? vc.ch === pc : CFN_SUFFIX_ALPHABET.test(pc);
      if (matches) next.add(p + 1);
    }
    current = closure(next);
    if (current.size === 0) return false;
  }
  return current.has(pattern.length);
}

/**
 * IAM のリソース ARN グロブ (`*` = 0 文字以上、`?` = 1 文字) と照合する。
 *
 * 大小文字は区別する（IAM のリソース ARN 照合と同じ）。ここを緩めると
 * 「carve-out が意図より広い」ことをテストが見逃す。
 *
 * `value` の全文字を `literal` として `globNfaMatches` へ委譲する
 * （`iamArnGlobMatchesGeneratedName` と同じ NFA・同じ意味論。動的 `RegExp` を経由しない）。
 */
export function iamArnGlobMatches(pattern: string, value: string): boolean {
  const chars: GlobValueChar[] = [...value].map((ch) => ({ kind: 'literal', ch }) as const);
  return globNfaMatches(pattern, chars);
}

/**
 * **末尾 12 文字がまだ決まっていない物理名**がそのパターンに一致し**うる**かを判定する。
 *
 * change set を見る時点では CloudFormation の乱数サフィックスは未確定である。
 *
 * 🔴 **ダミーのサフィックスを 1 つ当ててみる、という代用をしない。** それだと
 * 「たまたまそのダミーが一致しなかっただけ」を「一致しない」と読む —— パターンが
 * 末尾 `*` で終わらなくなった日に、carve-out に入るロールを静かに見逃す
 * （fail-open）。逆に「接頭辞さえ食えれば一致しうる」と丸めるのも誤りで、
 * パターン側に固定長の残りがある場合を通してしまう。
 *
 * ここでは未確定部分を「英数字が `suffixLength` 個」として厳密に評価する。
 *
 * `*` は `/` を跨ぐ（IAM のリソース ARN グロブと同じ）。人間の直感どおり
 * 「`/` で止まる」にすると、`Path` を細工したロールが carve-out の名前空間へ
 * 入り込むのを見逃す。
 */
export function iamArnGlobMatchesGeneratedName(
  pattern: string,
  knownPrefix: string,
  suffixLength: number = CFN_GENERATED_NAME_SUFFIX_LENGTH,
): boolean {
  const value: GlobValueChar[] = [...knownPrefix].map((ch) => ({ kind: 'literal', ch }) as const);
  for (let i = 0; i < suffixLength; i += 1) value.push({ kind: 'alnum' });
  return globNfaMatches(pattern, value);
}
