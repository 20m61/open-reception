/**
 * 試行予算の永続化（#1021 AC4）。判定そのものは `@/domain/security/attempt-budget`。
 *
 * ## なぜ `get` → `put` ではいけないか
 *
 * 🔴 **数え上げは read-modify-write なので、素朴に書くと並行で素通りする。**
 * 総当たりを仕掛ける側は**並列に**投げるので、全員が `failures: 0` を読んで全員が通る。
 * それは「予算」ではない ―― 上界が壊れる。このリポジトリは同型の lost-update を
 * #1158 に持っている（セキュリティ設定の同時更新）。
 *
 * だから `Collection.updateIf`（atomic compare-and-set。memory / dynamo 両方で
 * `update-if-contract.test.ts` が意味論を固定している）に載せ、CAS が負けたら読み直す。
 *
 * ## 窓のレコードは自然消滅させる
 *
 * `ttlSeconds` を付けて DynamoDB の TTL に任せる。掃除を運用に頼ると、溜まったときに
 * コストと「古い窓が残る面」の両方を作る。
 *
 * ## PII / secret
 *
 * 🔴 **鍵に PIN やパスワードを含めない。** 記録するのは「どの端末・どの発信元が何回
 * 失敗したか」だけで、**入力値は一切残さない**（`rules/pii-secret-minimization.md`）。
 */
import {
  consumeAttempt,
  type AttemptDecision,
  type AttemptPolicy,
  type AttemptWindow,
  type LayeredPolicy,
} from '@/domain/security/attempt-budget';
import { getBackend } from '@/lib/data';
import { GLOBAL_IDENTITY } from './client-identity';

/** 永続レコード。`id` は試行の鍵（`<scope>#<発信元>`。scope は `kiosk-authorize`）。 */
type AttemptRecord = {
  readonly id: string;
  readonly startedAt: number;
  /** 窓の中で**入場した**試行の回数（失敗数ではない。下の `reserveAttempt` を参照）。 */
  readonly attempts: number;
  /**
   * DynamoDB の TTL 属性（epoch 秒）。
   *
   * 🔴 **明示的に持つ（Codex レビュー P2）。** backend は `put` / `putIfAbsent` のときだけ
   * `ttlSeconds` から `ttl` を生成する（`recordFor`）。`updateIf` は**部分マージ**なので
   * `ttl` に触らない —— 同じレコードを新しい窓へ転がし続けると、**最初に作ったときの
   * 期限のまま**になり、稼働中のカウンタが 2 時間後に消えて**攻撃者の予算が戻る**。
   * だから窓を開き直すたびに、こちらで延ばす。
   */
  readonly ttl?: number;
};

/**
 * 窓の長さ（10 分）より十分長い TTL。窓が明けても少し残るが、
 * 判定は `startedAt` で行うので**残っていても影響しない**（残骸が効くことはない）。
 */
const TTL_SECONDS = 2 * 60 * 60;

/** CAS が負けたときの読み直し回数。並行数が多いほど負けるが、有限で止める。 */
const CAS_RETRIES = 16;

/** TTL 属性の値（epoch 秒）。窓を開き直すたびに延ばす。 */
const ttlAt = (now: number) => Math.floor(now / 1000) + TTL_SECONDS;

const attempts = () =>
  getBackend().collection<AttemptRecord>('auth-attempts', { ttlSeconds: TTL_SECONDS });

function toWindow(record: AttemptRecord | undefined): AttemptWindow | undefined {
  if (record === undefined) return undefined;
  // 🔴 壊れたレコードで 500 にしない（未認証経路なので、1 件で全端末が落ちる）。
  //    読めないものは「窓が無い」＝許可側へ倒す —— 予算は次の失敗から数え直される。
  //
  // 🔴 **`typeof` の検査は撤回した（変異検証で生存＝等価）。** `Number.isFinite` は
  //    引数を**強制変換しない**ので、文字列・`undefined`・`null` はすべて false になる
  //    （グローバルの `isFinite` と違う点）。2 段で書いていたのは片方が無駄だった。
  if (!Number.isFinite(record.startedAt) || !Number.isFinite(record.attempts)) return undefined;
  return { startedAt: record.startedAt, failures: record.attempts };
}

/**
 * 試行を**原子的に予約する**。入場できたら `allowed: true` を返し、**その時点で 1 回数える**。
 *
 * ## なぜ「判定」と「記録」を分けてはいけないか（Codex レビュー P1）
 *
 * 最初は読み取り専用の `checkAttempt` で入場を判定し、照合の**後**に `recordFailure` で
 * 数えていた。**数え上げが原子的であることは、入場が原子的であることを何も意味しない** ——
 * 並行バーストでは全員が「予算内」と読んで**全員が照合へ進む**。実測では
 * **予算 3 に対して 20 回中 20 回が照合まで到達し、0 回しか断られなかった**。
 *
 * つまり総当たりは**並列に投げるだけで素通り**でき、PBKDF2 の計算増幅も閉じていなかった。
 * 入場そのものを CAS で予約することでしか閉じられない。
 *
 * ## 数えるのは「入場した試行」で、失敗数ではない
 *
 * 照合の結果を待たずに数えるので、成功した試行も 1 回として数える。**成功したら
 * `recordSuccess` で窓ごと捨てる**ので、正当な利用者が予算を削られることはない
 * （逐次で予算ぶんちょうど入場できることをテストで固定している）。
 *
 * 途中で落ちた要求は数えられたまま残る —— **安全side へ倒す**ための意図的な選択である。
 */
export async function reserveAttempt(
  key: string,
  policy: AttemptPolicy,
  now: number,
): Promise<AttemptDecision> {
  for (let i = 0; i < CAS_RETRIES; i += 1) {
    const current = await attempts().get(key);
    const window = toWindow(current);
    const decision = consumeAttempt(policy, window, now);
    // 予算超過は書き込まずに断る（**未認証経路から書き込みを無限に誘発させない**）。
    if (!decision.allowed) return decision;

    const next = decision.nextWindow;
    // 🔴 窓を開き直すときは **TTL も延ばす**（`updateIf` は `recordFor` を通らない）。
    const rolling = window === undefined || next.startedAt !== window.startedAt;
    const attemptsNext = next.failures + 1;

    if (current === undefined) {
      // 不在なら条件付き作成（`putIfAbsent` は `recordFor` を通るので TTL は backend が付ける）。
      if (await attempts().putIfAbsent({ id: key, startedAt: next.startedAt, attempts: 1 })) {
        return decision;
      }
      continue; // 他が先に作った → 読み直す
    }
    // 🔴 **読めないレコードは CAS せず上書きする。**
    //
    //    レコードが在るが `toWindow` が読めない（`NaN` 等）場合、`expected` に読めない値を
    //    渡すことになる。`NaN === NaN` は偽なので **CAS は永遠に勝てず**、リトライを
    //    使い切って「断る」へ落ちる —— **壊れたレコード 1 件で全端末が締め出される**
    //    （テストで実測した）。読めない値は守るべき lost-update を持たないので、
    //    素直に `put` で置き換える（`recordFor` を通るので TTL も付く）。
    if (window === undefined) {
      await attempts().put({ id: key, startedAt: next.startedAt, attempts: 1 });
      return decision;
    }
    const changes: Partial<AttemptRecord> = rolling
      ? { startedAt: next.startedAt, attempts: attemptsNext, ttl: ttlAt(now) }
      : { startedAt: next.startedAt, attempts: attemptsNext };
    // 🔴 **`expected` には読んだ値をそのまま渡す**（CAS）。緩めると並行で予算を超える。
    const won = await attempts().updateIf(key, changes, {
      startedAt: current.startedAt,
      attempts: current.attempts,
    });
    if (won) return decision;
  }
  // 🔴 **CAS を使い切ったことを「予算超過」として返さない（独立レビュー 4 周目 MINOR-1）。**
  //
  //    以前はここで `{ allowed: false, retryAfterMs: policy.windowMs }` を返していた。
  //    通す訳にはいかない（予算が実質的に増える）ので断ること自体は正しいが、**予算は
  //    1 回も使われていない**のに:
  //
  //    - ログが `attempt budget exhausted ... until the window expires` と**嘘をつく**
  //    - 来訪者に「入力の試行が続いたため制限しています」＝**あなたの試行のせい**と出る
  //    - `retryAfterMs` が窓の長さ（10 分）になり、実際はすぐ再試行できるのに待たせる
  //
  //    3 周目 MAJOR-1（degraded と closed が同じ信号になりログが嘘をつく）と**同じ族**である。
  //
  //    🔴 **第 3 の判定値は足さない。** これは「帳簿が要求を完了できなかった」であって、
  //    既に在る `unavailable`（503 ＋ `reportAttemptStoreUnavailable`）**そのもの**である。
  //    throw して `reserveLayeredSafely` に拾わせれば、機構は増えるどころか**減る**
  //    （分岐が 1 つ消える）。
  throw new Error('attempt store: compare-and-set did not converge');
}

/** 成功したので窓ごと捨てる（正しく入った直後に予算切れで断られる形を作らない）。 */
export async function recordSuccess(key: string): Promise<void> {
  await attempts().remove(key);
}

/** テスト用: 記録を消す。 */
export async function __resetAttempts(): Promise<void> {
  await attempts().reset();
}

/**
 * 層になった予算を予約する（#1021 AC4 / レビュー B1・B2・2 周目 M-2）。
 *
 * ## 規則
 *
 * | 状況 | 一次 | 二次 |
 * | --- | --- | --- |
 * | 発信元を識別できる | `#<発信元>` に `perOrigin` | `#global` に cap |
 * | 識別できない | **無い**（発信元が無いので per-origin は成立しない） | cap だけ |
 *
 * 🔴 **識別できないときに一次を数えない**（レビュー 2 周目 M-2）。以前は退避鍵
 * `GLOBAL_IDENTITY` のとき一次鍵が**二次鍵と同一レコード**になっており、実測で
 * 一次予算（小さいほう）だけで閉まっていた ―― 二次 cap の値が**効いていなかった**。
 * 識別できないのに共有鍵で per-origin を数えるのは per-origin ではないので、
 * **cap だけで数える**。
 *
 * その代償: CloudFront を経ないデプロイでは **kiosk の制限が cap 1 本になる**
 * （全端末で 60 回/10 分を共有する）。稼働中の端末は 30 日 cookie で動き続けるので、
 * 影響は「攻撃中は初回 PIN 認可が詰まりうる」に留まる。**per-origin が効くとは書かない。**
 *
 * ## 順序が持っている上界
 *
 * 一次 → 二次の順で消費するので、**1 つの発信元が二次へ入れられるのは高々
 * `perOrigin.budget` 回**である（順序を入れ替えると 1 IP だけで cap を使い切れる）。
 * これは doc ではなくテストで縛ってある。
 *
 * 🔴 **一次で通って二次で断ったとき、一次の 1 回は消費されたままになる。** 攻撃が
 * 止んだ後も、**自分の窓が明けるまで**（最大 1 窓）その発信元は閉じたままになりうる
 * （レビュー m-1 の実測。戻そうとすると戻す操作自体が競合して予算が増える経路を作る）。
 */
export async function reserveLayered(
  identity: string,
  scope: string,
  layers: LayeredPolicy,
  now: number,
): Promise<AttemptDecision> {
  const globalKey = `${scope}#${GLOBAL_IDENTITY}`;
  // 発信元が無いので一次は成立しない ―― cap だけで数える。
  if (identity === GLOBAL_IDENTITY) return reserveAttempt(globalKey, layers.global, now);
  const primary = await reserveAttempt(`${scope}#${identity}`, layers.perOrigin, now);
  if (!primary.allowed) return primary;
  return reserveAttempt(globalKey, layers.global, now);
}

/**
 * 成功したので、その発信元と global の両方の窓を捨てる。
 *
 * 🔴 **失敗しても呼び出し側を止めない（レビュー M2）。** ここが throw すると
 * **正しい PIN / パスワードを入れた人が、帳簿の書き込み失敗だけで受付を開始できない**
 * （実測: `recordSuccess` を reject させると authorize は未捕捉 500 になり、
 * `issueKioskSession` が一度も呼ばれなかった）。捨て損なっても予算は**窓明けで自然に戻る**ので、
 * 失敗を飲んでよい唯一の箇所である。**沈黙はさせない** —— 呼び出し側がログへ寄せる。
 */
export async function recordLayeredSuccess(identity: string, scope: string): Promise<boolean> {
  try {
    await recordSuccess(`${scope}#${identity}`);
    if (identity !== GLOBAL_IDENTITY) await recordSuccess(`${scope}#${GLOBAL_IDENTITY}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 予約を試み、ストアが落ちていたら **fail-closed** で断る（レビュー M2）。
 *
 * 🔴 **fail-open は撤回した（3 周目 MAJOR-1・MAJOR-2）。** 一度は経路ごとに
 * 倒れ方を選べるようにしたが、`'open'` を使うのは admin だけで、その admin を
 * 増分から外したので**守るものが無くなった**。残したままだと:
 *
 * - degraded（通した）と closed（断った）が**同じ信号**になり、ログが
 *   「refusing attempts (fail-closed)」と**嘘をつく**（実測）
 * - `catch` があらゆる例外を飲むので、**実装バグでも制限が静かに外れる**
 *   （`.claude/rules/opus5-autonomous-loop.md`「フォールバックは大声の失敗を
 *   沈黙の誤動作へ変換する」そのもの）
 *
 * kiosk が断っても**稼働中の端末は 30 日 cookie で動き続ける**ので、
 * fail-closed の代償は「攻撃中は初回 PIN 認可ができない」に留まる。
 *
 * 🔴 **未捕捉 throw にはしない。** 未認証経路なので、例外を素通しにすると
 * スタックトレースつきの 500 を無制限に生ませられる。
 */
export async function reserveLayeredSafely(
  identity: string,
  scope: string,
  layers: LayeredPolicy,
  now: number,
): Promise<AttemptDecision | 'unavailable'> {
  try {
    return await reserveLayered(identity, scope, layers, now);
  } catch {
    return 'unavailable';
  }
}
