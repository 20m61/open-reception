import { TENANT_FEATURE_FLAG_KEYS } from '@/domain/platform/feature-flags';

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
export function isFlagsSummaryShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const flags = body.flags;
  if (!isRecord(flags)) return false;
  const vonage = flags.vonage;
  if (!isRecord(vonage) || typeof vonage.enabled !== 'boolean' || typeof vonage.configured !== 'boolean') {
    return false;
  }
  if (!Array.isArray(flags.authMethods) || !flags.authMethods.every(isAuthMethodShape)) return false;
  /*
   * 🔴 **キーは導出する。ハードコードしない (#968 レビュー 8 周目 m5)。**
   * API は `...tenantFlagSummary`（= `TENANT_FEATURE_FLAG_KEYS` の spread）で返すので、
   * ここで `voiceSynthesis` / `avatarReception` を手写しすると**キーを増減させたときに
   * 片方だけ壊れる**。同じファイルの `isTenantFlagsShape` は keys を引数で受けており、
   * 導出方法が食い違っていた。
   */
  return TENANT_FEATURE_FLAG_KEYS.every((k) => isTenantFlagSummaryShape(flags[k]));
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
 */
export const PLATFORM_WRITE_TIMEOUT_MS = 30_000;

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
