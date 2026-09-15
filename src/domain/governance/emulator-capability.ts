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
 * **緑のまま嘘をつく**。表へ描くときも ✅ にしない。記号は手で書かず
 * `matrixMark()` から導出する（散文が実測から遅れるのを機械で止める）。
 */

/** 能力を主張するために通らなければならない操作の結果。 */
export type PositiveOutcome = 'passed' | 'failed';

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
  /** 正が通らない。ローカルでは検証できない（が、嘘はつかない）。 */
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
 * 正／負の対照から能力を判定する。
 *
 * 🔴 **`positive === 'passed'` だけで `verified` を返さない。** それがこの関数の全部である。
 */
export function classifyCapability(probe: CapabilityProbe): CapabilityVerdict {
  if (probe.positive === 'failed') return 'unavailable';
  switch (probe.negative) {
    case 'rejected':
      return 'verified';
    case 'accepted':
      return 'permissive';
    case 'unreachable':
      return 'inconclusive';
  }
}

const MARKS: Readonly<Record<CapabilityVerdict, string>> = {
  verified: '✅',
  // 「使える」と読めない記号を選ぶ。permissive は unavailable より危険なので ⛔ とも分ける。
  permissive: '🔴 素通り',
  unavailable: '⛔',
  inconclusive: '?',
};

/** matrix へ描く記号。**✅ を返すのは `verified` だけ**。 */
export function matrixMark(verdict: CapabilityVerdict): string {
  return MARKS[verdict];
}
