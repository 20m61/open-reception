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

/**
 * `PositiveOutcome` の総当たり。**記号の予約**（`capability-doc.ts` の
 * `NEGATIVE_CONTROL_ONLY_VERDICTS`）を `classifyCapability` から導出するために要る。
 * 手で並べた一覧ではなく、ここを唯一の出どころにする。
 */
export const POSITIVE_OUTCOMES: ReadonlyArray<PositiveOutcome> = ['passed', 'failed', 'unreachable'];

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
  // 🔴 記号は**この表が唯一の出どころ**である。`docs/local-aws.md` の表と
  // `docs/development/local-aws-sandbox.md` の証拠表は、probe の実測記録と**行ごとに**
  // 突き合わせてある（#1113 / `capability-doc.ts` / `tests/config/capability-doc-sync.test.ts`）
  // ので、ここを変えれば両方の文書が落ちる。
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
 * probe の終了コード。**「測れなかった」で 0 を返さない**（レビュー round1 M2）。
 * 素通り(1) > 判定不能(3) > 正常(0) の順で強い。
 */
export function exitCodeFor(verdicts: ReadonlyArray<CapabilityVerdict>): 0 | 1 | 3 {
  if (verdicts.includes('permissive')) return 1;
  if (verdicts.includes('inconclusive')) return 3;
  return 0;
}

/**
 * 2 つの呼び方で測った負の対照をまとめる。
 *
 * 🔴 **どちらかが受理したら素通りである。** 「本番の呼び方では拒否されるが、別の呼び方なら
 * 誤った PW でも通る」エミュレータが実在する（Moto）。本番の呼び方だけを見て `verified` と
 * 書くと、呼び方を 1 つ変えただけで崩れる保証を ✅ として記録することになる
 * （レビュー round3 M-iii）。
 *
 * 🔴 **正の対照が通っていないときの `rejected` は信用しない。** `cognito-srp.ts` は
 * `UserNotFoundException` も `NotAuthorizedException` も `invalid_credentials` へ畳むので、
 * 「ユーザーに到達できていない」と「パスワードが拒否された」が見分けられない
 * （レビュー round2 MAJOR-3）。
 */
export function combineNegativeOutcomes(input: {
  readonly positive: PositiveOutcome;
  readonly production: NegativeOutcome;
  readonly alternate: NegativeOutcome;
}): NegativeOutcome {
  if (input.production === 'accepted' || input.alternate === 'accepted') return 'accepted';
  if (input.positive !== 'passed') return 'unreachable';
  return input.production;
}

/**
 * SRP 能力の測定**そのもの**。効果（ログイン試行）は注入する。
 *
 * 🔴 **これが script 側に無いことが要点である**（レビュー round3 MAJOR-2）。
 * probe はエミュレータ稼働を前提にするため既定ゲートから実行できない。判定を script に
 * 置くと、綴りを変えずに意味だけ変える変異（`classifyCapability({negative: 'rejected'})` を
 * 直接渡す等）が**全テスト緑のまま通る**ことを round3 が 9 種の変異で実測した。
 * 静的な綴り検査では塞げないので、**合成ごとここへ持ち上げて unit で縛る**。
 */
export async function measureSrpCapability(effects: {
  readonly loginWithCorrectPassword: () => Promise<LoginAttempt>;
  readonly loginWithWrongPassword: () => Promise<LoginAttempt>;
  readonly loginWithWrongPasswordAlternateShape: () => Promise<NegativeOutcome>;
}): Promise<{
  readonly positive: PositiveOutcome;
  readonly negative: NegativeOutcome;
  readonly verdict: CapabilityVerdict;
}> {
  const good = await effects.loginWithCorrectPassword();
  const bad = await effects.loginWithWrongPassword();
  const alternate = await effects.loginWithWrongPasswordAlternateShape();
  const positive = positiveFromLoginResult(good);
  const negative = combineNegativeOutcomes({
    positive,
    production: negativeFromLoginResult(bad),
    alternate,
  });
  return { positive, negative, verdict: classifyCapability({ positive, negative }) };
}

/**
 * 測定結果の要約と終了コード。**「測れなかった」で 0 を返さない。**
 * 🔴 空の結果を成功として扱わない（round3 W2: `exitCodeFor([])` が素通りした）。
 */
export function summarizeMeasurements(verdicts: ReadonlyArray<CapabilityVerdict>): {
  readonly code: 0 | 1 | 3;
  readonly permissive: number;
  readonly inconclusive: number;
} {
  if (verdicts.length === 0) {
    // 1 件も測れていないのは「全部問題なし」ではない。
    return { code: 3, permissive: 0, inconclusive: 0 };
  }
  return {
    code: exitCodeFor(verdicts),
    permissive: verdicts.filter((v) => v === 'permissive').length,
    inconclusive: verdicts.filter((v) => v === 'inconclusive').length,
  };
}

/**
 * 真偽で測る能力の測定**そのもの**。効果は注入する（Cognito と同じ理由。round3 MAJOR-2）。
 *
 * `runPositive` は「能力が働くこと」、`runNegative` は「**拒否されること**」を返す。
 * 🔴 `runNegative` が `true` を返す＝拒否された、である。呼び出し側で反転させない。
 */
export async function measureBooleanCapability(effects: {
  readonly runPositive: () => Promise<BooleanProbe>;
  readonly runNegative: () => Promise<BooleanProbe>;
}): Promise<{
  readonly positive: PositiveOutcome;
  readonly negative: NegativeOutcome;
  readonly verdict: CapabilityVerdict;
}> {
  const positive = positiveFromBooleanProbe(await effects.runPositive());
  const negative = negativeFromBooleanProbe(await effects.runNegative());
  return { positive, negative, verdict: classifyCapability({ positive, negative }) };
}
