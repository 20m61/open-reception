/**
 * platform の read 応答が**実際に読むフィールドを持っているか** (#968 レビュー 6 周目)。
 *
 * ## なぜ「キーの有無」では足りなかったか
 *
 * 5 周目までは `if (body.fleet === undefined)` のように**キーが在るか**だけを見ていた。
 * 独立レビューが実測したとおり、それは 1 段しか見ておらず、`null` と部分形を通す:
 *
 * | 注入した 200 | 起きたこと |
 * | --- | --- |
 * | `{"fleet":null}` | render で投げ、**運用コンソールに来訪者向け文言**「受付を続けられませんでした」 |
 * | `{"flags":{}}` | 同上（`data.flags.vonage.enabled` が投げる） |
 * | `{"detail":null}` | 永遠の「読み込み中」（#870 / #896 が閉じた形の再現） |
 * | `{"detail":{}}` | 「テナント詳細: undefined」＋「拠点がありません」断定＋**状態不明のまま破壊的操作ボタン** |
 * | `{"config":{}}` | secret を「未設定」と断定し、**全置換 upsert の保存ボタンが有効化** |
 *
 * `.claude/rules/opus5-autonomous-loop.md` が必須としている「**数値/条件パラメータを狭める**」型の
 * 変異を自分の行列に入れていなかったので、5 周にわたって見えていなかった
 * （著者の変異は全部「検査を丸ごと外す」型だった）。
 *
 * ## 何を検査するか
 *
 * **画面が実際に読むフィールドだけ**を見る。「型どおり全部」ではない —— 型の全項目を
 * 検査すると、サーバが任意フィールドを足したときに読めなくなる（互換の方向が逆になる）。
 *
 * ここは純関数なので `fetch` を持たない。`tests/config/platform-fetch-failure.test.ts` の
 * 走査母集団には import 推移閉包で入る。
 */

/** オブジェクト（`null` でも配列でもない）か。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const DASHBOARD_FLEET_NUMBERS = ['total', 'active', 'suspended'] as const;
export const DASHBOARD_RECEPTION_NUMBERS = ['total', 'connected', 'timeout', 'failed'] as const;

/**
 * `/api/platform/dashboard`。
 *
 * 🔴 **`receptionsToday` を落としていた (#968 レビュー 7 周目 MAJOR-2)。**
 * 画面は `data?.receptionsToday?.total ?? '—'` と optional chain で読むので、
 * 欠けても投げない代わりに **4 枚のカードが `—` のまま無言**になる。
 * 「まだ来ていない」と「取れなかった」が区別できない —— #968 AC2 が名指しした
 * 無言の `—` そのもので、受付が全滅していても運用者は気づけない。
 */
export function isDashboardShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const fleet = body.fleet;
  if (!isRecord(fleet)) return false;
  if (!DASHBOARD_FLEET_NUMBERS.every((k) => typeof fleet[k] === 'number')) return false;
  const receptions = body.receptionsToday;
  if (!isRecord(receptions)) return false;
  return DASHBOARD_RECEPTION_NUMBERS.every((k) => typeof receptions[k] === 'number');
}

/** `flags.authMethods[]`。画面は `id`（key）/ `label` / `enabled` / `issues.length` を読む。 */
function isAuthMethodShape(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return (
    typeof row.id === 'string' &&
    typeof row.label === 'string' &&
    typeof row.enabled === 'boolean' &&
    Array.isArray(row.issues)
  );
}

/** `flags.voiceSynthesis` / `flags.avatarReception`。画面は 2 つとも読む。 */
function isTenantFlagSummaryShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.defaultEnabled === 'boolean' && typeof value.disabledTenants === 'number';
}

/**
 * `/api/platform/feature-flags`。
 *
 * 🔴 **`vonage` だけ見ていたのは狭すぎた (#968 レビュー 7 周目 MAJOR-1)。**
 * 画面は同じ応答から `authMethods[].label/enabled/issues` と 2 つの
 * `TenantFlagSummary` も**無条件に**読む。`{"authMethods":[{}]}` は 6 周目の述語を
 * **通ったうえで** `m.issues.length` が投げ、運用者は「読めなかった」ではなく
 * 汎用の例外画面を受け取っていた（レビューが実測）。
 *
 * この取りこぼしは「X1（error boundary を消す変異）は等価」という私の主張が
 * **誤りだった**ことの証拠でもある —— 述語が受理する応答で投げる経路が実在した。
 */
export function isFlagsSummaryShape(body: unknown, summaryKeys: readonly string[]): boolean {
  if (!isRecord(body)) return false;
  const flags = body.flags;
  if (!isRecord(flags)) return false;
  const vonage = flags.vonage;
  if (!isRecord(vonage) || typeof vonage.enabled !== 'boolean' || typeof vonage.configured !== 'boolean') {
    return false;
  }
  if (!Array.isArray(flags.authMethods) || !flags.authMethods.every(isAuthMethodShape)) return false;
  /*
   * 🔴 **「画面が読むキー」を呼び出し側から受ける (#968 レビュー 9 周目 m6)。**
   *
   * 8 周目は `TENANT_FEATURE_FLAG_KEYS`（ドメイン定数）から導出したが、**描画側は
   * `voiceSynthesis` / `avatarReception` を手書きしている**。キーを 1 つ増やすと
   * 述語だけが厳しくなり、クライアント先行デプロイの skew で「**画面が一切読まない
   * フィールドが欠けている**」ことを理由に機能フラグ画面が丸ごと落ちる ——
   * このファイルが 20 行上で自ら戒めている「型の全項目を検査すると互換の方向が逆になる」
   * そのもの。`isTenantFlagsShape` と同じく keys を引数で受け、描画と一致させる。
   */
  return summaryKeys.every((k) => isTenantFlagSummaryShape(flags[k]));
}

/** `/api/platform/tenants/[id]/feature-flags`。画面は `flags[key]` を真偽で読む。 */
export function isTenantFlagsShape(body: unknown, keys: readonly string[]): boolean {
  if (!isRecord(body)) return false;
  const flags = body.flags;
  if (!isRecord(flags)) return false;
  return keys.every((k) => typeof flags[k] === 'boolean');
}

/**
 * `/api/platform/tenants/[id]`。画面は `name` / `status` / `sites` を読む。
 *
 * 🔴 **`status` は破壊的操作のラベルを決める。** 欠けていると
 * `data.status === 'active' ? '停止する' : '有効化する'` が **undefined で偽**になり、
 * **状態が読めていないテナントに「有効化する」を提示**する。押せば PATCH は正しい
 * tenantId へ飛ぶので監査には正しく残り、運用者だけが何をしたか分からない。
 */
export const TENANT_DETAIL_STRINGS = ['name', 'slug', 'status'] as const;
export const TENANT_DETAIL_NUMBERS = [
  'siteCount',
  'deviceCount',
  'activeDeviceCount',
  'maintenanceDeviceCount',
] as const;
export const TENANT_SITE_STRINGS = ['id', 'name', 'status'] as const;
export const TENANT_SITE_NUMBERS = ['deviceCount', 'activeDeviceCount'] as const;

/**
 * 🔴 **配列の「要素」まで見る (#968 レビュー 6 周目 変異 X1 の途中で発見)。**
 *
 * `Array.isArray(sites)` だけだと `{"sites":[null]}` が述語を**通ったうえで**
 * `rowKey={(s) => s.id}` が投げる —— 表の 1 行目を描く瞬間に例外なので、
 * `error.tsx` が無ければ運用コンソールに来訪者向けの文言が出る経路そのものである。
 */
function isTenantSiteRowShape(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return (
    TENANT_SITE_STRINGS.every((k) => typeof row[k] === 'string') &&
    TENANT_SITE_NUMBERS.every((k) => typeof row[k] === 'number')
  );
}

export function isTenantDetailShape(detail: unknown): boolean {
  if (!isRecord(detail)) return false;
  if (!TENANT_DETAIL_STRINGS.every((k) => typeof detail[k] === 'string')) return false;
  if (!TENANT_DETAIL_NUMBERS.every((k) => typeof detail[k] === 'number')) return false;
  return Array.isArray(detail.sites) && detail.sites.every(isTenantSiteRowShape);
}

/**
 * `/api/platform/integrations/provider-config`。
 *
 * `config: null` は**正当**（そのテナントにまだ設定が無い）。値が在るなら、画面が読む
 * `provider` / `enabled` と、`presenceOf` が読む `secretPresence` を持つこと。
 * `secretPresence` は `TenantProviderConfigView` で必須なので、欠ける応答は壊れている ——
 * それを「未設定」と読むと、secret が実在するテナントを未設定と断定したうえで
 * **楽観ロックの無い全置換 upsert** の保存導線が開く。
 */
export function isProviderConfigShape(body: unknown): boolean {
  if (!isRecord(body) || !('config' in body)) return false;
  /*
   * 🔴 **`warnings` も画面が読む (#968 レビュー 7 周目 MAJOR-1)。**
   * `(data?.warnings ?? []).map(...)` は `warnings` が**配列でない**とき投げる
   * （`{}` は `??` を素通りする）。任意フィールドなので「無い」は正当、
   * 「在るが配列でない」だけを弾く。
   */
  if ('warnings' in body && body.warnings !== undefined && !Array.isArray(body.warnings)) {
    return false;
  }
  const config = body.config;
  if (config === null) return true;
  return (
    isRecord(config) &&
    typeof config.provider === 'string' &&
    typeof config.enabled === 'boolean' &&
    typeof config.secretPresence === 'string'
  );
}

export const TENANT_ROW_STRINGS = ['id', 'name', 'slug', 'status'] as const;

/**
 * `/api/platform/tenants`。**要素まで見る** (#968 レビュー 7 周目 BLOCKER-1)。
 *
 * 🔴 **ここだけは `error.tsx` が受けられない。** `TenantSwitcher` は
 * `src/app/platform/layout.tsx` が描画しており、Next の `error.tsx` は**同じ
 * セグメントの layout が投げた例外を捕まえない**。`{"tenants":[null]}` を返すと
 * `resolveViewingContext` の `tenants.map((t) => t.id)` が投げ、例外は root まで
 * 上がって `global-error.tsx` の**来訪者向け 4 言語**が platform の全画面に出る
 * （レビューが実測）。`Array.isArray` の 1 段検査では止まらない。
 */
export function isTenantRowShape(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return TENANT_ROW_STRINGS.every((k) => typeof row[k] === 'string');
}

/** `/api/platform/tenants` の応答全体。 */
export function isTenantListShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return Array.isArray(body.tenants) && body.tenants.every(isTenantRowShape);
}

/**
 * 応答が**返ってこない**ときの上限 (#968 レビュー 6 周目 MAJOR-4)。
 *
 * `reject` は拾えるようになったが、**ハング**（Lambda のコールドスタート・NAT の詰まり・
 * テザリング）は 5 経路とも無言のままだった —— 画面は「読み込み中」と正しく言い続け、
 * 復帰導線は失敗表示の中にあるので出ない。#968 が消そうとした「終わらない待ち」が、
 * 失敗ではなく**停止**という経路で丸ごと残っていた。
 */
export const PLATFORM_READ_TIMEOUT_MS = 15_000;

/**
 * 送信（PATCH / PUT / DELETE）が返ってこないときの上限 (#968 レビュー 7 周目 MAJOR-5)。
 *
 * read より長くとる —— 書込は往復が重く、途中で切ると「成功したのに失敗と読む」側の
 * 誤りが増える。それでも上限は要る: レビューの実測では、停止 PATCH を返さないまま
 * **18 秒後も画面に何も残らず**、昇格つきフラグ変更では **25 秒後も「変更中…」のまま**
 * 編集 UI 全体が固まっていた（リロード以外に出口が無い）。
 *
 * 🔴 **サーバの予算より長くする (#968 レビュー 9 周目 m5)。**
 *
 * web Lambda の `serverTimeoutSec` は 3 環境とも **30 秒**
 * （`infra/lib/config/environments.ts`）。クライアントを同じ 30 秒にすると、
 * **サーバ自身の 504 が必ずこちらの中断に負ける** —— 運用者は「サーバ側で確実に
 * 完了しなかった」という**知り得たはずの事実**に到達できず、常に hedge 文言を受け取って
 * 手で確認しに行くことになる。5 秒の余裕を持たせて、サーバの返事を先に見る。
 */
export const PLATFORM_WRITE_TIMEOUT_MS = 35_000;

/**
 * 🔴 **送信の中断は「失敗した」と言い切らない。**
 *
 * 中断したのは**こちらの待ち**であって、サーバは受理して監査に残しているかもしれない。
 * 「失敗しました」と断定すると、運用者は同じ破壊的操作をもう一度実行する。
 * 読み取り側（`readTimeoutMessage`）と違って、ここは**成功を否定しない**言い方にする。
 */
export function writeTimeoutMessage(what: string): string {
  return `${what}が時間内に完了しませんでした。送信できたかどうか分かりません。画面を再読み込みして、実際の状態を確認してください。`;
}

/** 上限を過ぎたことを運用者の言葉で言う。 */
export function readTimeoutMessage(what: string): string {
  return `${what}が時間内に返りませんでした。時間をおいて再試行してください。`;
}

/*
 * ============================================================================
 * #973: **形の検査が無かった 7 画面**（#968 が `tests/config/platform-fetch-failure.test.ts`
 * の台帳へ積んだ残り）。
 *
 * 上と同じ原則で書く —— **画面が実際に読むフィールドだけ**を見る。7 画面はどれも
 * 一覧なので、**0 件は正当**（失敗ではない）。片側だけを主張すると「全部を失敗と
 * 断定する」変異が空虚に通るので、`read-response.test.ts` は下界も対で張っている。
 * ============================================================================
 */

/** 配列の全要素が述語を満たすか（`[null]` を 1 段検査で通さない）。 */
function isArrayOf(value: unknown, row: (v: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(row);
}

/** 指定キーが全部その型で在るか。 */
function hasAll(row: Record<string, unknown>, keys: readonly string[], type: 'string' | 'number' | 'boolean'): boolean {
  return keys.every((k) => typeof row[k] === type);
}

/**
 * 監査ログ / 直近アクティビティの行。
 *
 * 画面が読む列は `id`（`rowKey`）/ 日時 / 操作 / 主体の 4 つ。`targetType` 以降は
 * すべて任意（`?? '-'` で描き分ける）ので**検査しない** —— サーバが返さない運用を
 * 「読めなかった」にしない。
 */
export const AUDIT_ROW_STRINGS = ['id', 'at', 'action', 'actor'] as const;

function isAuditRowShape(row: unknown): boolean {
  return isRecord(row) && hasAll(row, AUDIT_ROW_STRINGS, 'string');
}

/** `/api/platform/audit-logs`。 */
export function isAuditLogsShape(body: unknown): boolean {
  return isRecord(body) && isArrayOf(body.logs, isAuditRowShape);
}

/**
 * 外部連携の行（`Integrations` と `Observability` が同じ列を出す）。
 *
 * `lastResult` は `RESULT_LABEL[i.lastResult]` の添字になる。**値の集合までは縛らない** ——
 * サーバが新しい結果を足したときに画面が丸ごと落ちるのは互換の方向が逆で、
 * ここで守りたいのは「列が無言で空になる」ことだけである。
 */
export const INTEGRATION_ROW_STRINGS = ['id', 'label', 'lastResult'] as const;
export const INTEGRATION_ROW_BOOLEANS = ['configured', 'enabled'] as const;

function isIntegrationRowShape(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return (
    hasAll(row, INTEGRATION_ROW_STRINGS, 'string') && hasAll(row, INTEGRATION_ROW_BOOLEANS, 'boolean')
  );
}

/** `/api/platform/integrations`。連携一覧とログイン方式一覧を**両方**描く。 */
export function isIntegrationsShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return isArrayOf(body.integrations, isIntegrationRowShape) && isArrayOf(body.authMethods, isAuthMethodShape);
}

/**
 * `/api/platform/observability`。
 *
 * 🔴 **`successRate` は `number | null` が正当**（受付 0 件の月）。数値必須にすると
 * **正常な月初を「読めなかった」と誤報する** —— `config: null` と同じ型の下界。
 */
export const OBSERVABILITY_RECEPTION_NUMBERS = ['receptions', 'callFailures', 'noAnswer'] as const;
export const OBSERVABILITY_DEVICE_NUMBERS = ['total', 'online', 'offline', 'maintenance', 'disabled'] as const;

export function isObservabilityShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (!isArrayOf(body.integrations, isIntegrationRowShape)) return false;
  if (!isArrayOf(body.recentActivity, isAuditRowShape)) return false;
  const reception = body.reception;
  if (!isRecord(reception) || !hasAll(reception, OBSERVABILITY_RECEPTION_NUMBERS, 'number')) return false;
  if (!('successRate' in reception)) return false;
  if (reception.successRate !== null && typeof reception.successRate !== 'number') return false;
  const devices = body.devices;
  return isRecord(devices) && hasAll(devices, OBSERVABILITY_DEVICE_NUMBERS, 'number');
}

/**
 * `/api/platform/maintenance`。4 つの一覧＋4 枚の件数カードを描く。
 *
 * 🔴 **`windows` は `scheduledCount + activeCount` を足す。** 片方が欠けると
 * 例外にならず **`NaN` が画面に出る**（#968 の `receptionsToday` と同じ族で、
 * 「まだ無い」と「取れなかった」が区別できなくなる）。
 */
export const MAINTENANCE_DEVICE_ROW_STRINGS = ['deviceId', 'deviceName', 'tenantName', 'siteId'] as const;
export const INCIDENT_ROW_STRINGS = ['id', 'scope', 'severity', 'status', 'title', 'startedAt'] as const;
export const MAINTENANCE_WINDOW_ROW_STRINGS = [
  'id',
  'scope',
  'status',
  'impact',
  'message',
  'startsAt',
  'endsAt',
] as const;
export const NOTICE_ROW_STRINGS = ['id', 'scope', 'level', 'status', 'title', 'publishedAt'] as const;

function rowsWithCounts(
  section: unknown,
  counts: readonly string[],
  listKey: string,
  row: (v: unknown) => boolean,
): boolean {
  if (!isRecord(section) || !hasAll(section, counts, 'number')) return false;
  return isArrayOf(section[listKey], row);
}

export function isMaintenanceShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const stringRow = (keys: readonly string[]) => (row: unknown) => isRecord(row) && hasAll(row, keys, 'string');
  return (
    rowsWithCounts(body.summary, ['devicesInMaintenance'], 'devices', stringRow(MAINTENANCE_DEVICE_ROW_STRINGS)) &&
    rowsWithCounts(body.incidents, ['activeCount'], 'incidents', stringRow(INCIDENT_ROW_STRINGS)) &&
    rowsWithCounts(body.windows, ['scheduledCount', 'activeCount'], 'windows', stringRow(MAINTENANCE_WINDOW_ROW_STRINGS)) &&
    rowsWithCounts(body.notices, ['activeCount'], 'notices', stringRow(NOTICE_ROW_STRINGS))
  );
}

/**
 * `/api/platform/updates`。
 *
 * `byState` は**画面が読む 2 つだけ**を見る。`UpdateState` を全部要求すると、
 * サーバが新しい状態を足したときに一覧が丸ごと落ちる。
 */
export const UPDATE_ROW_STRINGS = [
  'id',
  'scope',
  'component',
  'currentVersion',
  'latestVersion',
  'state',
  'checkedAt',
] as const;
export const UPDATE_STATE_COUNTS = ['update_available', 'failed'] as const;

function isUpdateRowShape(row: unknown): boolean {
  return isRecord(row) && hasAll(row, UPDATE_ROW_STRINGS, 'string') && typeof row.pending === 'boolean';
}

export function isUpdateStatusShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const updates = body.updates;
  if (!isRecord(updates) || !hasAll(updates, ['pendingCount', 'totalCount'], 'number')) return false;
  const byState = updates.byState;
  if (!isRecord(byState) || !hasAll(byState, UPDATE_STATE_COUNTS, 'number')) return false;
  return isArrayOf(updates.updates, isUpdateRowShape);
}

/**
 * `/api/platform/tenants` を**一覧画面**が読む形。
 *
 * 🔴 **ヘッダの `TenantSwitcher`（`isTenantListShape`）とは別の述語にする。** 一覧画面は
 * `updatedAt` を列に出し、`summary` の 3 枚のカードも描く。同じ API でも読むものが
 * 違うので、片方に合わせると**読まないフィールドの欠落で画面が落ちる**（互換の方向が逆）。
 */
export function isTenantListPageShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const summary = body.summary;
  if (!isRecord(summary) || !hasAll(summary, DASHBOARD_FLEET_NUMBERS, 'number')) return false;
  return isArrayOf(body.tenants, (row) => isTenantRowShape(row) && isRecord(row) && typeof row.updatedAt === 'string');
}

/**
 * `/api/platform/costs`。
 *
 * `status` で分岐する応答なので、**知らない `status` は「読めなかった」**とする ——
 * 画面はどちらの節も描かず、失敗表示も出ないまま**何も無い枠**になる。
 * `filters` は分岐の外側で `data?.filters.environment` と読むので、両方の status で要る。
 */
export const COST_AVAILABLE_STRINGS = ['currency', 'breakdownBy', 'updatedAt'] as const;
export const COST_PERIOD_STRINGS = ['monthStart', 'actualEndExclusive'] as const;

/** `number | null`（予測が取れない月は `null` が正当）。 */
function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

export function isAwsCostShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const filters = body.filters;
  if (!isRecord(filters) || typeof filters.environment !== 'string') return false;
  if (typeof body.updatedAt !== 'string') return false;
  if (body.status === 'unavailable') return typeof body.message === 'string';
  if (body.status !== 'available') return false;
  if (!hasAll(body, COST_AVAILABLE_STRINGS, 'string')) return false;
  const period = body.period;
  if (!isRecord(period) || !hasAll(period, COST_PERIOD_STRINGS, 'string')) return false;
  if (typeof body.actualToDate !== 'number') return false;
  if (!isNullableNumber(body.forecastRemaining) || !isNullableNumber(body.monthEndEstimate)) return false;
  if (typeof body.forecastAvailable !== 'boolean') return false;
  return isArrayOf(
    body.breakdown,
    (item) => isRecord(item) && typeof item.key === 'string' && typeof item.amount === 'number',
  );
}
