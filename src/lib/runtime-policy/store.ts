/**
 * runtime policy（サービス単位の稼働ポリシー）のストア (#367)。
 *
 * **共通営業時間（`operating_policy`）とは別コレクションに置く。** `RuntimeOperatingPolicy` は
 * `commonSchedule` を内包する形なので 1 レコードに寄せたくなるが、`operating_policy` には
 * 稼働中の kiosk consumer（`kiosk-gate` / `call-guard`）が付いているので移行なしには統合できない。
 * 2 コレクションへ書き分ける案は、片方だけ成功した状態（営業時間だけ更新されてサービス設定が
 * 古い）を作れてしまうので採らない。**合成は読み出し時に行う**。
 *
 * 監査は専用 action `runtime_policy.updated`。時間帯の具体値は残さず、
 * 「誰がどのサービスを触ったか」までに留める（`.claude/rules/pii-secret-minimization.md`）。
 */
import type { PolicyValidationIssue } from '@/domain/operating-policy/types';
import { DEFAULT_TIMEZONE } from '@/domain/operating-policy/tz';
import {
  MANAGED_RUNTIME_SERVICES,
  type ManagedRuntimeService,
  type ManagedRuntimeServiceKey,
} from '@/domain/runtime-policy/registry';
import {
  hasAbsoluteOffset,
  resolveServiceStates,
  type CommonSchedule,
  type RuntimeOperatingPolicy,
  type ResolutionReason,
  type RuntimeStateResolution,
  type ServiceResolution,
} from '@/domain/runtime-policy/resolve';
import { validateRuntimePolicyInput } from '@/domain/runtime-policy/validate';
import { getBackend } from '@/lib/data';
import { appendAuditLog } from '@/lib/data-stores/reception-log-store';
import { getOperatingPolicy } from '@/lib/operating-policy/store';

/**
 * 永続化する部分。共通営業時間は持たない（読み出し時に合成する）。
 *
 * 🔴 **任意プロパティ（`?`）にしない。** `updateIf` はマージなので、キーを落とすと更新時に
 * 旧値が残る。`undefined` を**必須で明示**させる型にしておくと、書き込みリテラルからキーを
 * 落とした瞬間にコンパイルが落ちる（隣接 store の `emergencyContactLabel` 事故が構造的に
 * 再発しない）。
 */
export type RuntimePolicyDocument = {
  services: RuntimeOperatingPolicy['services'] | undefined;
  breakGlass: RuntimeOperatingPolicy['breakGlass'] | undefined;
};

export type RuntimePolicyRecord = RuntimePolicyDocument & {
  tenantId: string;
  siteId: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
};

type StoredRuntimePolicy = RuntimePolicyRecord & { id: string };

const COLLECTION = 'runtime_policy';

function collection() {
  return getBackend().collection<StoredRuntimePolicy>(COLLECTION);
}

// 区切り文字の混入で別 (tenant, site) 組と衝突しないよう、キー成分を制限する
// （`a:b`+`c` と `a`+`b:c` の衝突防止。`operating-policy/store.ts` と同じ規則）。
const KEY_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

export function runtimePolicyKey(tenantId: string, siteId: string): string {
  if (!KEY_PART_PATTERN.test(tenantId) || !KEY_PART_PATTERN.test(siteId)) {
    throw new Error('runtime-policy: invalid tenantId/siteId for policy key');
  }
  return `${tenantId}:${siteId}`;
}

export type StoreError = {
  code: 'invalid_input' | 'conflict';
  message: string;
  issues: PolicyValidationIssue[];
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/** 保存済みのサービス設定。未設定なら null（＝ registry の既定 mode で動く）。 */
export async function getRuntimePolicy(tenantId: string, siteId: string): Promise<RuntimePolicyRecord | null> {
  const found = await collection().get(runtimePolicyKey(tenantId, siteId));
  return found ? stripId(found) : null;
}

function stripId(stored: StoredRuntimePolicy): RuntimePolicyRecord {
  const { id: _id, ...rest } = stored;
  return rest;
}

/*
 * 🔴 **route 層の封筒はここで剥がす（#798 AC5）。** 隣接する `operating-policy` の route/store は
 * `tenantId` / `siteId` / `expectedVersion` を**同じ body に載せて** validator へ渡す作法だが、
 * `validateRuntimePolicyInput` はポリシー文書だけを受け取り未知キーを拒否する。剥がさずに
 * 渡すと、同じ形で繋いだ瞬間に全リクエストが 400 になる。
 */
const ENVELOPE_FIELDS = ['tenantId', 'siteId', 'expectedVersion'] as const;

function splitEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  const document: Record<string, unknown> = { ...raw };
  for (const field of ENVELOPE_FIELDS) delete document[field];
  return document;
}

/**
 * 封筒のスコープが認可済みのスコープと食い違っていたら弾く。**黙って捨てない。**
 * 捨てると、将来 route が Cookie 由来のスコープを使うようになったとき、body で別サイトを
 * 指定した運用者が「サイト B を止めた」つもりでサイト A を触ることになる。
 */
function envelopeScopeMismatch(
  raw: Record<string, unknown>,
  tenantId: string,
  siteId: string,
): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  if (raw.tenantId !== undefined && raw.tenantId !== tenantId) {
    issues.push({ field: 'tenantId', message: 'does not match the authorized scope' });
  }
  if (raw.siteId !== undefined && raw.siteId !== siteId) {
    issues.push({ field: 'siteId', message: 'does not match the authorized scope' });
  }
  return issues;
}

function fail(code: StoreError['code'], message: string, issues: PolicyValidationIssue[] = []): Result<never> {
  return { ok: false, error: { code, message, issues } };
}

/**
 * `expectedVersion` の型不正は**競合ではない**。409 は「読み直して再試行せよ」の意味だが、
 * 型が違う要求は何度やっても成功しない——永久に直らない指示になる。400 + issues で返す。
 */
function readExpectedVersion(raw: Record<string, unknown>): number | undefined | 'invalid' {
  const value = raw.expectedVersion;
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

/**
 * 検証のときだけ被せる共通営業時間。**実物は読まない。**
 *
 * `validateRuntimePolicyInput` は文書全体を要求するが、サービス個別の契約（mode の整合・
 * 区間ゼロ・例外日の形・未知キー）は共通側の値に依存しない。実物を読んで合成しても
 * 受理集合は変わらず（変異で確認）、代わりに「営業時間を先に設定しないとサービス設定を
 * 保存できない」という**保存の順序の強制**が生まれるだけになる。運用者がどちらを先に
 * 触るかは決められないので、ここは固定値で通し、解決だけが実物を読む。
 */
const VALIDATION_PLACEHOLDER_SCHEDULE: CommonSchedule = {
  timezone: DEFAULT_TIMEZONE,
  weeklySchedule: {},
  fixedHolidays: [],
  exceptionDates: [],
};

export async function upsertRuntimePolicy(
  tenantId: string,
  siteId: string,
  updatedBy: string,
  raw: unknown,
): Promise<Result<RuntimePolicyRecord>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('invalid_input', 'runtime policy is invalid', [{ field: 'body', message: 'must be an object' }]);
  }
  const body = raw as Record<string, unknown>;
  const requested = readExpectedVersion(body);
  if (requested === 'invalid') {
    return fail('invalid_input', 'runtime policy is invalid', [
      { field: 'expectedVersion', message: 'must be a non-negative integer' },
    ]);
  }
  const mismatch = envelopeScopeMismatch(body, tenantId, siteId);
  if (mismatch.length > 0) return fail('invalid_input', 'runtime policy is invalid', mismatch);
  const document = splitEnvelope(body);

  /*
   * 共通営業時間はこの経路で書かせない。黙って無視すると「設定したのに効かない」になり、
   * しかも運用者は営業時間を変えたつもりでいる。専用の endpoint へ誘導する。
   */
  if (document.commonSchedule !== undefined) {
    return fail('invalid_input', 'runtime policy is invalid', [
      { field: 'commonSchedule', message: 'is managed by the operating-policy endpoint' },
    ]);
  }

  const validated = validateRuntimePolicyInput({
    ...document,
    commonSchedule: VALIDATION_PLACEHOLDER_SCHEDULE,
  });
  if (!validated.ok) return { ok: false, error: validated.error };

  const id = runtimePolicyKey(tenantId, siteId);
  const expectedVersion = requested;
  const existing = await collection().get(id);
  if (existing === null || existing === undefined) {
    // 「更新のつもり」で来たのに実体が無い＝別経路で消された等。作成へ倒さない。
    /*
     * ここと下の「expectedVersion 必須」はクライアントの実装ミスで、同時編集ではない。
     * 監査に混ぜるとリトライで線形に増え、本命の同時編集イベントが埋もれる。
     */
    if (expectedVersion !== undefined) {
      return fail('conflict', 'runtime policy does not exist (expectedVersion was given)');
    }
  } else if (expectedVersion === undefined) {
    return fail('conflict', 'expectedVersion is required to update an existing runtime policy');
  }
  /*
   * version の一致判定はここでは**しない**。読んでから書くまでの隙間があるので、権威は下の
   * CAS（`updateIf`）1 か所に置く。事前判定を足しても同じ結果・同じ文言になるだけで、
   * 「先に読んだ値で判断する」経路を 2 本持つことになる。
   */

  /*
   * 🔴 **`updateIf` はマージ、`put` は置換。** 省略された任意フィールドは**キーごと落とさず
   * `undefined` を明示する**。落とすと更新時に旧値が残り、API は「消えた」と答えるのに
   * 永続状態には古い設定が居座る。break-glass が消えないと、解除したはずの緊急停止が
   * 毎分の解決で復活する（memory は上書き、dynamo は REMOVE で削除が成立する）。
   */
  const stored: StoredRuntimePolicy = {
    id,
    tenantId,
    siteId,
    services: validated.value.services,
    breakGlass: validated.value.breakGlass,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  if (existing) {
    // 読んでから書くまでの隙間も塞ぐ（CAS）。false = その間に誰かが書いた。
    const applied = await collection().updateIf(id, stored, { version: expectedVersion });
    if (!applied) {
      return conflictWithAudit(tenantId, siteId, id, updatedBy, 'runtime policy was updated by someone else');
    }
  } else {
    /*
     * 🔴 **無条件 `put` にしない。** `get` → 無ければ `put` は原子的でないので、2 人が同時に
     * 初回作成すると片方が無言で消える。消えるのが緊急停止なら「止めたつもり」が残る。
     */
    const created = await collection().putIfAbsent(stored);
    if (!created) {
      return conflictWithAudit(tenantId, siteId, id, updatedBy, 'runtime policy was created by someone else');
    }
  }

  /*
   * 実施者は **`actor` に載せる**（`appendAdminAudit` は `'admin'` 固定なので使わない）。
   * `platform:<identity>` / `kiosk:<id>` と同じ流儀で、`maskAuditActor` のマスク対象にもなる。
   * metadata に置くとレコードの `updatedBy` 同様、次の更新で上書きされて追えなくなる。
   * （`sanitizeAuditMetadata` は `recordDangerAction` 経由にしか掛からないので、
   * 「actor に置けば sanitize される」という理由付けではない。）
   */
  await recordAudit({
    action: 'runtime_policy.updated',
    actor: `admin:${updatedBy}`,
    targetType: 'runtime_policy',
    targetId: stored.id,
    metadata: {
      resource: 'runtime_policy',
      tenantId,
      siteId,
      version: String(stored.version),
      // 時間帯の具体値は残さない。どのサービスを触ったかまで。
      configuredServiceKeys: Object.keys(stored.services ?? {}).sort().join(','),
      breakGlass: stored.breakGlass ? (stored.breakGlass.active ? 'active' : 'inactive') : 'unset',
      /*
       * `breakGlass.serviceKeys` の省略は「保護対象以外を**全部**止める」を意味する。
       * `configuredServiceKeys` は別物（サービス個別設定のキー）なので、事後レビューで
       * 「何も止まっていない」と誤読されないよう、範囲を独立して残す。
       */
      breakGlassScope: breakGlassScopeOf(stored.breakGlass),
    },
  });
  return { ok: true, value: stripId(stored) };
}

function breakGlassScopeOf(breakGlass: RuntimeOperatingPolicy['breakGlass']): string {
  if (!breakGlass?.active) return 'none';
  const keys = breakGlass.serviceKeys;
  return keys && keys.length > 0 ? keys.join(',') : 'all_unprotected';
}

/**
 * 同時編集の競合を監査に残す（「2 人が同時に運用状態を触った」は緊急時に最も知りたい運用イベント）。
 *
 * 🔴 監査の失敗で **409 を 500 に化けさせない**。「読み直して再試行せよ」は返せるのに返せなく
 * なるのが、緊急時に一番起きてほしくない壊れ方。握ったことはログに出す。
 */
async function conflictWithAudit(
  tenantId: string,
  siteId: string,
  id: string,
  updatedBy: string,
  message: string,
): Promise<Result<never>> {
  await recordAudit({
    action: 'runtime_policy.update_conflicted',
    actor: `admin:${updatedBy}`,
    targetType: 'runtime_policy',
    targetId: id,
    metadata: { resource: 'runtime_policy', tenantId, siteId, reason: message },
  });
  return fail('conflict', message);
}

/**
 * 監査の失敗で**結果を返せなくしない**。成功経路も競合経路も同じ扱いにする——成功だけ
 * 例外にすると、「保存は成功したのに 500 が返り、再送すると version が進んでいて 409」という
 * 「止められなかった」と読める壊れ方を作る。握ったことはログに出す。
 */
async function recordAudit(entry: Parameters<typeof appendAuditLog>[0]): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (err) {
    // どの拠点の監査行が欠落したかを特定できるようにする（`targetId` は `<tenantId>:<siteId>`）。
    console.error('[runtime-policy] failed to record audit', {
      action: entry.action,
      targetId: entry.targetId,
      reason: (err as { name?: string }).name ?? 'unknown',
    });
  }
}

/**
 * 解決の結果。**「判定不能」を単一の `undefined` で表さない。**
 *
 * 🔴 共通営業時間を実際に読むのは段 5（`follow_operating_hours`）だけ。それが未設定だからと
 * 解決全体を諦めると、**break-glass や `manual_only` が「保存できるのに絶対に効かない」**
 * ——API は 200、画面は「停止しました」、監査にも残るのに EC2 は動き続ける。このモジュールの
 * 下層が名指しで潰した失敗を、1 階層上で再生産することになる。
 *
 * `error` と `partial` も分ける。前者は「壊れている（人が見るべき）」、後者は「まだ設定して
 * いない（正常な途中状態）」で、運用者が取るべき行動が違う。
 */
export type RuntimeResolutionOutcome =
  | { readonly kind: 'resolved'; readonly resolution: RuntimeStateResolution }
  | {
      readonly kind: 'partial';
      /** 判定できたサービスだけ。capabilities は集計値なので出さない（半分正しい集合は誤用される）。 */
      readonly services: readonly ServiceResolution[];
      /** 共通営業時間が無いと決められないサービス。呼び出し側は**現状を変えない**。 */
      readonly unresolved: readonly ManagedRuntimeServiceKey[];
    }
  | { readonly kind: 'error'; readonly reason: string };

/** 共通営業時間が無いときに段 5 へ渡す値。結果は `unresolved` として捨てるので中身は効かない。 */
const UNKNOWN_COMMON_SCHEDULE: CommonSchedule = {
  timezone: DEFAULT_TIMEZONE,
  weeklySchedule: {},
  fixedHolidays: [],
  exceptionDates: [],
};

export async function resolveRuntimeStatesFor(
  tenantId: string,
  siteId: string,
  atMs: number = Date.now(),
): Promise<RuntimeResolutionOutcome> {
  let common: Awaited<ReturnType<typeof getOperatingPolicy>>;
  let runtime: RuntimePolicyRecord | null;
  try {
    common = await getOperatingPolicy(tenantId, siteId);
    runtime = await getRuntimePolicy(tenantId, siteId);
  } catch (err) {
    /*
     * 🔴 **黙って捨てない。** ここを undefined に潰すと、壊れたレコード 1 件や継続的な
     * DynamoDB 障害が Reconciler を**恒久的な no-op** にし、EC2 が上がりっぱなし（費用）か
     * 上がらないまま（受付不能）で固定される——しかも 1 分ごとに静かに失敗し続ける。
     * PII を載せず名前だけ出す（`operating-policy/call-guard.ts` と同じ書式）。
     */
    const reason = (err as { name?: string }).name ?? 'unknown';
    console.error('[runtime-policy] failed to read policy; reporting error', { tenantId, siteId, reason });
    return { kind: 'error', reason };
  }

  const policy: RuntimeOperatingPolicy = {
    commonSchedule: common
      ? {
          timezone: common.timezone,
          weeklySchedule: common.weeklySchedule,
          fixedHolidays: common.fixedHolidays,
          exceptionDates: common.exceptionDates,
        }
      : UNKNOWN_COMMON_SCHEDULE,
    ...(runtime?.services ? { services: runtime.services } : {}),
    ...(runtime?.breakGlass ? { breakGlass: runtime.breakGlass } : {}),
  };

  /*
   * 解決も判定不能の切り分けも**同じ catch で受ける**。分けると、片方だけ守った非対称が
   * 生まれる（切り分け側は現状 throw しないので、専用の catch は殺せない分岐になる）。
   * 解決はまだ総関数ではない（`resolve.ts` が明記）ので、壊れたレコードは「見るべき異常」。
   */
  let resolution: RuntimeStateResolution;
  let unresolved: Set<ManagedRuntimeServiceKey>;
  try {
    resolution = resolveServiceStates({ policy, now: atMs });
    if (common) return { kind: 'resolved', resolution };
    unresolved = unresolvedWithoutCommonSchedule(resolution.services, runtime?.services);
  } catch (err) {
    const reason = (err as { name?: string }).name ?? 'unknown';
    console.error('[runtime-policy] failed to resolve policy; reporting error', { tenantId, siteId, reason });
    return { kind: 'error', reason };
  }
  return {
    kind: 'partial',
    services: resolution.services.filter((service) => !unresolved.has(service.serviceKey)),
    // 並びは**解決の順**に揃える（`services` 側と同じ列から作るので、両者が必ず分割になる）。
    unresolved: resolution.services.map((s) => s.serviceKey).filter((key) => unresolved.has(key)),
  };
}

/*
 * 🔴 **共通営業時間が無い＝拠点の timezone が分からない。** `resolve.ts` は timezone を
 * `commonSchedule` から取り、段 2〜5（override の失効判定・例外日・サービス個別スケジュール・
 * 共通週間スケジュール）すべてが現地時刻の解釈に使う。したがって「段 5 だけが共通側を読む」は
 * 誤りで、**時刻の解釈が絡む判断は全部**信用できない。
 *
 * 信用してよいのは時刻に依らない切り替えだけ——break-glass と、`always_on` / `manual_only`
 * （＝ `default_policy`）。これは前回 BLOCKER として直した「未設定だと緊急停止が効かない」を
 * 保ったまま、捏造した timezone 由来の値を「決まった」と言わない線引きになる。
 */
/**
 * 段ごとに「拠点の timezone が要るか」。**`Record<ResolutionReason, boolean>` で持つ**ので、
 * `resolve.ts` に段が増えたらコンパイルが落ちる。集合で持っていると、入れ忘れが
 * 「黙って確定値として報告する」（＝過剰確定）として現れ、型では捕まらない。
 */
const NEEDS_TIMEZONE_BY_REASON: Record<ResolutionReason, boolean> = {
  /*
   * 段 1。段 2 より上なので TZ に依らず決まる。この表より前で早期 return するため
   * **この行自体は到達しない**が、`ResolutionReason` の網羅を型で強制するために要る。
   */
  break_glass: false,
  // 段 2。実際には `expiresAt` を見て決めるので、ここへ落ちるのは想定外。安全側に倒す。
  temporary_override: true,
  // 段 3〜5。いずれも現地時刻の解釈が要る。
  exception_date: true,
  custom_service_schedule: true,
  common_weekly_schedule: true,
  // 段 6。mode だけで決まる（`always_on` / `manual_only`）。
  default_policy: false,
  // 依存補正。自分ではなく**依存元**の判定で決まるので、閉包側が扱う。
  dependency_correction: false,
};

/**
 * その判断が拠点の timezone を要るか。
 *
 * 🔴 **`reason` だけで決めない。** 段 2（一時 override の失効判定）は捏造した TZ で行われ、
 * 「失効した」と判断されると **reason から `temporary_override` が消える**（段 6 の
 * `default_policy` に落ちる）。reason を見ている限り「TZ 次第で結論が変わる」ことを検出できず、
 * `manual_only` + オフセット無しの `force_running` が「確定して停止」と報告されていた。
 * override を持つサービスは、`expiresAt` が絶対時刻でない限り常に判定不能とする。
 * 段 1（break-glass）だけは段 2 より上なので、TZ に依らず確定する。
 */
function needsSiteTimezone(
  service: Pick<ServiceResolution, 'serviceKey' | 'reason'>,
  overrides: RuntimeOperatingPolicy['services'] | undefined,
): boolean {
  if (service.reason === 'break_glass') return false;
  const expiresAt = overrides?.[service.serviceKey]?.temporaryOverride?.expiresAt;
  /*
   * 🔴 **ここで打ち切らない。** 絶対時刻の override でも**失効していれば段 3〜6 へ落ちる**ので、
   * 結論は落ちた先の段で決まる。`expiresAt` を見た時点で「確定」と返していたため、
   * 期限付きの停止を一度でも絶対時刻で使った拠点は、期限切れ後そのサービスが恒久的に
   * 確定扱いになっていた（自動解除は読み取り時のみで、レコードには残り続ける）。
   * 型ドリフト（非文字列）でも throw しない——`resolve.ts` は同じ入力を総関数として扱う。
   */
  if (expiresAt !== undefined && !(typeof expiresAt === 'string' && hasAbsoluteOffset(expiresAt))) {
    return true;
  }
  // 段 2 で決まった＝絶対時刻の override が有効。ここだけは reason が結論を保証する。
  if (service.reason === 'temporary_override') return false;
  return NEEDS_TIMEZONE_BY_REASON[service.reason];
}

/**
 * 判定不能なサービス集合。**依存先を辿って推移的に広げる**——依存補正は reason を
 * `dependency_correction` に書き換えるので、段 5 由来の停止が「決まった値」として漏れていた
 * （実測: 共通未設定で `stt: always_on` が `blockedBy: realtime-conversation` により stopped、
 * しかも当の realtime-conversation は判定不能）。
 */
export function unresolvedWithoutCommonSchedule(
  services: readonly ServiceResolution[],
  overrides: RuntimeOperatingPolicy['services'] | undefined,
  registry: readonly ManagedRuntimeService[] = MANAGED_RUNTIME_SERVICES,
): Set<ManagedRuntimeServiceKey> {
  const unresolved = new Set(
    services.filter((service) => needsSiteTimezone(service, overrides)).map((s) => s.serviceKey),
  );
  const byKey = new Map(services.map((service) => [service.serviceKey, service]));
  // 解決に含まれるサービスだけを辿る（`resolveServiceStates` は部分集合で呼べる）。
  const present = registry.filter((service) => byKey.has(service.serviceKey));

  // 依存は非循環（`registry.test.ts` が固定）なので、変化が無くなるまで回せば閉じる。
  for (let changed = true; changed; ) {
    changed = false;
    for (const service of present) {
      if (unresolved.has(service.serviceKey)) continue;
      /*
       * 🔴 **確定した停止は飲み込まない。** 依存補正は severity を上げることしかできず
       * （`resolve.ts` の `applyDependencyCorrections`）、`stopped` は最大値なので、時刻に
       * 依らない理由で既に停止しているサービスは依存先が不明でも値が変わらない。ここを
       * 落とすと、スコープ付き break-glass や `manual_only` が「保存できるのに効かない」に戻る。
       * 補正済みなら**補正前の自分の判断**を見る（補正で stopped に化けた側は判定不能のまま）。
       */
      const resolved = byKey.get(service.serviceKey);
      const from = resolved?.correction?.from ?? resolved;
      if (
        from?.state === 'stopped' &&
        !needsSiteTimezone({ serviceKey: service.serviceKey, reason: from.reason }, overrides)
      ) {
        continue;
      }
      if (service.dependsOn.some((dep) => unresolved.has(dep))) {
        unresolved.add(service.serviceKey);
        changed = true;
      }
    }
  }
  return unresolved;
}

/** テスト用: ストアを空へ戻す。 */
export async function __resetRuntimePolicyStore(): Promise<void> {
  await collection().reset();
}
