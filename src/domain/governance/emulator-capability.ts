/**
 * ローカル AWS エミュレータの「能力」を、**負の対照つき**で判定する（#1103 / ADR 0010）。
 *
 * ## なぜ「動いた」では足りないのか
 *
 * `.claude/rules/local-aws-development.md` は既に「ベンダ固有の health パスで到達性を
 * 判定するな、実際に使う AWS API で確かめろ」と言っている。2026-09-14 の #1103 の実測は、
 * **それでもまだ足りない**ことを示した。
 *
 * MiniStack の Cognito は、本番モジュール `cognitoSrpLogin` からの
 * `InitiateAuth(USER_SRP_AUTH)` に正しい形の `PASSWORD_VERIFIER` チャレンジを返し、
 * `RespondToAuthChallenge` に**署名の合わない SRP 証明を渡しても ID/Access トークンを
 * 発行した**。Moto も（`ChallengeResponses.USERNAME` の扱いが実 AWS と違うため経路は
 * 別だが）同じく誤ったパスワードを受理した。
 *
 * 「実際に使う API を叩いて成功した」を根拠にすると、この 2 つはどちらも ✅ になる。
 * だが**認証で価値があるのは拒否するほうである**。成功だけを見る判定は、認証を
 * 「素通りさせる実装」と「正しく検証する実装」を区別できない —— これは
 * `CLAUDE.md`「検証の作法」の「下界を併せて縛る」がそのまま当てはまる形で、
 * **全部を受理する世界でも通る主張**になっている。
 *
 * だから能力の主張には必ず**負の対照**（拒否されなければならない操作）を組にする。
 *
 * ## permissive を ✅ に丸めない
 *
 * 🔴 `permissive`（正は通るが負も通る）は `unavailable` より**危険**である。
 * 使えないエミュレータは使った瞬間に分かるが、素通りするエミュレータは
 * **緑のまま嘘をつく**。表へ描くときも ✅ にしない。
 */

/**
 * 能力を主張するために通らなければならない操作の結果。
 * `unreachable` は「操作を走らせられなかった」であって、能力が無いことではない。
 */
export type PositiveOutcome = 'passed' | 'failed' | 'unreachable';

/**
 * 拒否されなければならない操作（負の対照）の結果。
 * `unreachable` は「対照そのものを走らせられなかった」であって、成功でも失敗でもない。
 */
export type NegativeOutcome = 'rejected' | 'accepted' | 'unreachable';

export type CapabilityVerdict =
  /** 正は通り、負は拒否された。ローカルで意味のある検証ができる。 */
  | 'verified'
  /** 🔴 正も負も通った。素通りしている。ローカルの緑は空虚。 */
  | 'permissive'
  /**
   * 正が通らない。ローカルでは**その能力を使えない**。
   * 🔴 「素通りしない」ことまでは主張しない —— 負の対照が走っていない場合があるため
   * （レビュー round2 MAJOR-2）。呼び方を変えれば素通りする可能性は残る。
   */
  | 'unavailable'
  /** 負の対照を走らせられなかった。「測れなかった」を他へ倒さない。 */
  | 'inconclusive';

export const CAPABILITY_VERDICTS: ReadonlyArray<CapabilityVerdict> = [
  'verified',
  'permissive',
  'unavailable',
  'inconclusive',
];

export type CapabilityProbe = {
  readonly positive: PositiveOutcome;
  readonly negative: NegativeOutcome;
};

/**
 * ログイン試行の結果（`cognitoSrpLogin` の戻り値と構造的に一致する形）。
 * 依存を持ち込まないため、ここでは最小の形だけを受ける。
 */
export type LoginAttempt =
  | { readonly ok: true; readonly idToken?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 正／負の対照から能力を判定する。
 *
 * 🔴 **`positive === 'passed'` だけで `verified` を返さない。** それがこの関数の全部である。
 */
export function classifyCapability(probe: CapabilityProbe): CapabilityVerdict {
  // 🔴 **素通りが支配する。** 拒否すべきものを受理した事実は、正の対照が何であっても
  // 最も危険な信号である。ここを「正が落ちたら unavailable」で先に畳むと、
  // **素通りするエミュレータが「嘘はつかない」⛔ に化ける**（Moto が実際にその形だった）。
  if (probe.negative === 'accepted') return 'permissive';
  // 正の対照を走らせられなかったなら、何も知らない。
  if (probe.positive === 'unreachable') return 'inconclusive';
  // 正の対照を**実際に走らせて落ちた**のは知識である（負の対照の可否に関わらず使えない）。
  if (probe.positive === 'failed') return 'unavailable';
  // 正は通った。負を確かめられていないなら verified とは言えない。
  if (probe.negative === 'unreachable') return 'inconclusive';
  return 'verified';
}

/**
 * ログイン試行の結果を**負の対照**の outcome へ落とす。
 *
 * 🔴 **「成功しなかった」を「拒否された」と読まない。** 負の対照で価値があるのは
 * 「**資格情報が理由で**拒否された」ことだけである。障害（`error`: ネットワーク・5xx・
 * throttle・トークン欠落）や追加チャレンジ（MFA・初回 PW 変更）は、パスワードが
 * 誤っていたから止まった証拠にならない。これらを `rejected` に畳むと、
 * **負の対照が落ちているだけのエミュレータが `verified` に化ける**。
 */
export function negativeFromLoginResult(result: LoginAttempt): NegativeOutcome {
  if (result.ok) return 'accepted';
  return result.reason === 'invalid_credentials' ? 'rejected' : 'unreachable';
}

const MARKS: Readonly<Record<CapabilityVerdict, string>> = {
  verified: '✅',
  // 「使える」と読めない記号を選ぶ。permissive は unavailable より危険なので ⛔ とも分ける。
  // 🔴 記号は**この表が唯一の出どころ**だが、`docs/local-aws.md` の表は手書きである
  // （突き合わせる機械検査はまだ無い。レビュー round2 MINOR-3）。
  permissive: '🔴 素通り',
  unavailable: '⛔',
  inconclusive: '?',
};

/** matrix へ描く記号。**✅ を返すのは `verified` だけ**。 */
export function matrixMark(verdict: CapabilityVerdict): string {
  return MARKS[verdict];
}

/** 正の対照: ログイン結果を outcome へ。障害は「能力が無い」ではない。 */
export function positiveFromLoginResult(result: LoginAttempt): PositiveOutcome {
  if (result.ok) return 'passed';
  return result.reason === 'error' ? 'unreachable' : 'failed';
}

/** 真偽で測る probe の結果。例外（`'threw'`）を `false` と混ぜない。 */
export type BooleanProbe = boolean | 'threw';

/** 正の対照: `true` なら通った / `'threw'` は走らせられなかった。 */
export function positiveFromBooleanProbe(r: BooleanProbe): PositiveOutcome {
  if (r === 'threw') return 'unreachable';
  return r ? 'passed' : 'failed';
}

/** 負の対照: `true` = 期待どおり拒否された / `false` = 受理された（素通り）。 */
export function negativeFromBooleanProbe(r: BooleanProbe): NegativeOutcome {
  if (r === 'threw') return 'unreachable';
  return r ? 'rejected' : 'accepted';
}

/**
 * 負の対照を、本番の呼び方の結果と代替の呼び方の結果から決める。
 *
 * 🔴 **正の対照が通っていないときの `rejected` を信用しない**（レビュー round2 MAJOR-3）。
 * `cognito-srp.ts` は `UserNotFoundException` も `NotAuthorizedException` も
 * `invalid_credentials` へ畳むので、「ユーザーに到達できていない」と
 * 「パスワードが拒否された」が見分けられない。正の対照が通っていないなら、
 * そもそもパスワード検証まで到達していないので**拒否の証拠にならない**。
 *
 * 🔴 **代替の呼び方は `accepted` のときだけ上書きする**（同 MINOR-4）。
 * 実測できた `rejected` を「走らせられなかった」で捨てない。
 */
export function resolveNegativeOutcome(input: {
  readonly positive: PositiveOutcome;
  readonly production: NegativeOutcome;
  readonly fallback: NegativeOutcome;
}): NegativeOutcome {
  if (input.production === 'accepted') return 'accepted';
  if (input.fallback === 'accepted') return 'accepted';
  // 正の対照が通っていない＝拒否の証拠にならない。
  if (input.positive !== 'passed') return 'unreachable';
  return input.production;
}

/**
 * probe の終了コード。**「測れなかった」で 0 を返さない**（レビュー round1 M2）。
 * 素通り(1) > 判定不能(3) > 正常(0) の順で強い。
 */
export function exitCodeFor(verdicts: ReadonlyArray<CapabilityVerdict>): 0 | 1 | 3 {
  if (verdicts.includes('permissive')) return 1;
  if (verdicts.includes('inconclusive')) return 3;
  return 0;
}

/**
 * 代替の呼び方（別の呼び出し形）で負の対照をやり直すべきか。
 *
 * 🔴 **本番の呼び方で正の対照が通らなかったときこそ試す。** そこで諦めて
 * `unavailable` と記録すると、「呼び方を変えれば素通りする」エミュレータが
 * **安全そうな ⛔ に化ける**（Moto が実際にその形だった。レビュー round1 M3）。
 * 既に素通りが分かっているなら、やり直す必要はない。
 */
export function shouldTryFallbackNegative(input: {
  readonly positive: PositiveOutcome;
  readonly production: NegativeOutcome;
}): boolean {
  if (input.production === 'accepted') return false;
  return input.positive !== 'passed';
}

/**
 * 負の対照を決める。**代替の呼び方を試すかどうかの判断もここで持つ。**
 *
 * 🔴 **呼び出し側に「試すか」の条件を書かせない。** レビュー round2 で、条件を script 側に
 * 置いたままだと `!shouldTryFallbackNegative(...)` と否定するだけで M3（Moto が ⛔ に化ける）
 * が復活し、テストは全部緑のままだった。実行できない層に判断を残さないのが唯一の対策で、
 * `tryFallback` は**効果の注入**であって判断ではない。
 */
export async function decideNegativeOutcome(input: {
  readonly positive: PositiveOutcome;
  readonly production: NegativeOutcome;
  readonly tryFallback: () => Promise<NegativeOutcome>;
}): Promise<NegativeOutcome> {
  const fallback = shouldTryFallbackNegative(input) ? await input.tryFallback() : 'unreachable';
  return resolveNegativeOutcome({
    positive: input.positive,
    production: input.production,
    fallback,
  });
}
