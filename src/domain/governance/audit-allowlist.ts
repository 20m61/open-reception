/**
 * 依存監査の結果を「止めるもの」と「期限付きで受容したもの」へ分ける (#634)。
 *
 * ## なぜ allowlist が要るのか
 *
 * `npm audit` は 1 件でも見つかれば非ゼロで終わる。**上流が直すまでこちらでは直せない**
 * advisory が 1 件あるだけで、ゲートが恒久的に赤になる。
 *
 * 実例: `brace-expansion` の GHSA-rgw5-rvv9-x895 は `aws-cdk-lib` の
 * **`bundleDependencies`** に入っているため、npm の `overrides` でも `npm audit fix` でも
 * 触れない（tarball の中に同梱されている）。上流が再バンドルするまで手段が無い。
 *
 * 赤を放置すると「赤を無視する習慣」がつき、**本物の脆弱性も見えなくなる**（#424 増分 3 と
 * 同じ理屈）。かといって `--audit-level` で丸ごと緩めると、その severity 全体が盲点になる。
 * よって **advisory 単位・理由付き・期限付き**で受容する。
 *
 * ## 期限が本体
 *
 * 受容は「今は直せない」であって「気にしない」ではない。期限を過ぎたら**自動で blocking へ
 * 戻る**ので、放置すると必ず表面化する。上流が直せば `unused` として報告され、entry を消す
 * 合図になる。
 */

export interface Advisory {
  /** GHSA-xxxx-xxxx-xxxx。 */
  readonly id: string;
  readonly severity: string;
  /** 脆弱なパッケージ名。 */
  readonly module: string;
  /** 検出されたワークスペース（`root` / `infra`）。 */
  readonly workspace: string;
  readonly title: string;
}

export interface AllowEntry {
  readonly id: string;
  /** なぜ今は直せないのか。「対応中」では不可、手段が無い理由を書く。 */
  readonly reason: string;
  /** `YYYY-MM-DD`。この日を**過ぎたら** blocking へ戻る（当日はまだ有効）。 */
  readonly expires: string;
  /** 指定すると、その module の advisory にだけ効く。 */
  readonly module?: string;
}

export interface AuditVerdict {
  /** ゲートを落とすべき advisory。 */
  readonly blocking: Advisory[];
  /** 期限内の entry で受容されたもの。 */
  readonly allowed: Advisory[];
  /** 期限切れの entry（許可として働かない）。 */
  readonly expired: AllowEntry[];
  /** 期限内だが 1 件も該当が無かった entry（＝上流が直した合図）。 */
  readonly unused: AllowEntry[];
}

/** 期限は「その日いっぱい有効」。日付だけの比較にして時刻で揺らさない。 */
function isExpired(entry: AllowEntry, now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return entry.expires < today;
}

function matches(entry: AllowEntry, advisory: Advisory): boolean {
  if (entry.id !== advisory.id) return false;
  return entry.module === undefined || entry.module === advisory.module;
}

export function evaluateAudit(
  found: readonly Advisory[],
  allowlist: readonly AllowEntry[],
  now: Date,
): AuditVerdict {
  const live = allowlist.filter((e) => !isExpired(e, now));
  const expired = allowlist.filter(
    (e) => isExpired(e, now) && found.some((a) => matches(e, a)),
  );

  const blocking: Advisory[] = [];
  const allowed: Advisory[] = [];
  for (const advisory of found) {
    if (live.some((e) => matches(e, advisory))) allowed.push(advisory);
    else blocking.push(advisory);
  }

  // 「未使用」は期限内の entry についてのみ意味がある。期限切れは expired 側で報告済み。
  const unused = live.filter((e) => !found.some((a) => matches(e, a)));

  return { blocking, allowed, expired, unused };
}
