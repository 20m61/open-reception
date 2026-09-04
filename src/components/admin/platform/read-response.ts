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

/** `/api/platform/dashboard`。画面は `fleet.total` / `active` / `suspended` を読む。 */
export function isDashboardShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const fleet = body.fleet;
  if (!isRecord(fleet)) return false;
  return ['total', 'active', 'suspended'].every((k) => typeof fleet[k] === 'number');
}

/** `/api/platform/feature-flags`。画面は `flags.vonage.enabled` / `configured` を読む。 */
export function isFlagsSummaryShape(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const flags = body.flags;
  if (!isRecord(flags)) return false;
  const vonage = flags.vonage;
  return isRecord(vonage) && typeof vonage.enabled === 'boolean' && typeof vonage.configured === 'boolean';
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
  const config = body.config;
  if (config === null) return true;
  return (
    isRecord(config) &&
    typeof config.provider === 'string' &&
    typeof config.enabled === 'boolean' &&
    typeof config.secretPresence === 'string'
  );
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

/** 上限を過ぎたことを運用者の言葉で言う。 */
export function readTimeoutMessage(what: string): string {
  return `${what}が時間内に返りませんでした。時間をおいて再試行してください。`;
}
