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
} from '@/domain/security/attempt-budget';
import { getBackend } from '@/lib/data';

/** 永続レコード。`id` は試行の鍵（`kiosk:<kioskId>` / `admin:<発信元>`）。 */
type AttemptRecord = {
  readonly id: string;
  readonly startedAt: number;
  readonly failures: number;
};

/**
 * 窓の最大長（10 分 / 15 分）より十分長い TTL。窓が明けても少し残るが、
 * 判定は `startedAt` で行うので**残っていても影響しない**（残骸が効くことはない）。
 */
const TTL_SECONDS = 2 * 60 * 60;

/** CAS が負けたときの読み直し回数。並行数が多いほど負けるが、有限で止める。 */
const CAS_RETRIES = 8;

const attempts = () =>
  getBackend().collection<AttemptRecord>('auth-attempts', { ttlSeconds: TTL_SECONDS });

function toWindow(record: AttemptRecord | undefined): AttemptWindow | undefined {
  if (record === undefined) return undefined;
  // 🔴 壊れたレコードで 500 にしない（未認証経路なので、1 件で全端末が落ちる）。
  //    読めないものは「窓が無い」＝許可側へ倒す —— 予算は次の失敗から数え直される。
  if (typeof record.startedAt !== 'number' || typeof record.failures !== 'number') return undefined;
  if (!Number.isFinite(record.startedAt) || !Number.isFinite(record.failures)) return undefined;
  return { startedAt: record.startedAt, failures: record.failures };
}

/**
 * 試行してよいかを判定する（**数えない**）。
 *
 * 🔴 **判定と記録を分ける。** 呼び出し側は「断られたら照合を走らせない」ので、
 * 予算超過の試行は PBKDF2 のコストを**払わない**（#1021 AC3 が持ち込んだ増幅を閉じる側）。
 */
export async function checkAttempt(
  key: string,
  policy: AttemptPolicy,
  now: number,
): Promise<AttemptDecision> {
  return consumeAttempt(policy, toWindow(await attempts().get(key)), now);
}

/**
 * 失敗を 1 つ数える。**原子的**（CAS。負けたら読み直す）。
 *
 * 窓が明けていれば新しい窓を `failures: 1` で開く。
 */
export async function recordFailure(
  key: string,
  policy: AttemptPolicy,
  now: number,
): Promise<void> {
  for (let i = 0; i < CAS_RETRIES; i += 1) {
    const current = await attempts().get(key);
    const window = toWindow(current);
    const expired = window === undefined || now - window.startedAt >= policy.windowMs;
    if (current === undefined) {
      // 不在なら条件付き作成。負けたら（他が先に作った）読み直す。
      if (await attempts().putIfAbsent({ id: key, startedAt: now, failures: 1 })) return;
      continue;
    }
    const next: AttemptRecord = expired
      ? { id: key, startedAt: now, failures: 1 }
      : { id: key, startedAt: window.startedAt, failures: window.failures + 1 };
    // 🔴 **`expected` には読んだ値をそのまま渡す**（CAS）。ここを緩めると並行で取りこぼす。
    const won = await attempts().updateIf(
      key,
      { startedAt: next.startedAt, failures: next.failures },
      { startedAt: current.startedAt, failures: current.failures },
    );
    if (won) return;
  }
  // 🔴 **諦めるときは安全側へ倒す。** 数え損なうと予算が実質的に増えるので、
  //    最後の手段として窓を「使い切った」状態へ寄せる（下界は窓明けが保証する）。
  await attempts().put({ id: key, startedAt: now, failures: policy.budget });
}

/** 成功したので失敗数を捨てる（正しく入った直後に予算切れで断られる形を作らない）。 */
export async function recordSuccess(key: string): Promise<void> {
  await attempts().remove(key);
}

/** テスト用: 記録を消す。 */
export async function __resetAttempts(): Promise<void> {
  await attempts().reset();
}
