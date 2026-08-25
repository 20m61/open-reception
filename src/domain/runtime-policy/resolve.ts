/**
 * サービス稼働ポリシーの解決（純ドメイン、issue #367 Increment 1）。
 *
 * issue 本文の優先順位チェーンを 1 つの純関数へ落とす。
 *
 * ```text
 * break-glass force stop
 *   > temporary override
 *   > exception date          （サービス個別の例外日）
 *   > custom service schedule （サービス個別の週間スケジュール）
 *   > common weekly schedule  （サイト共通の営業時間 = 既存 evaluateOperatingStatus）
 *   > default policy          （registry の既定モード）
 * ```
 *
 * 設計上の約束:
 *   - **I/O を持たない**。永続化（DynamoDB）・EC2 の start/stop・EventBridge・監査ログは本
 *     increment の対象外で、この解決結果を入力にする後続 increment の責務。
 *   - **共通営業時間の評価は再実装しない**。`@/domain/operating-policy/schedule` の
 *     `evaluateOperatingStatus` を「共通営業時間の段」としてだけ再利用する（曜日別・固定休業日・
 *     単発例外・日跨ぎ区間・タイムゾーンの判定はそちらが正本）。
 *   - **`temporaryOverride` は読み取り時に失効させる**（`expiresAt <= now` は無視）。期限切れを
 *     書き戻す非同期処理に依存せず、判定だけで「一時 override が期限後に自動解除される」
 *     （#367 受入条件）を満たす。`@/lib/operating-policy/call-guard` と同じ流儀。
 *   - **依存に反する組合せは安全側へ補正する**。依存先が stopped / draining なら依存元も
 *     そこまで落とし、`reason: 'dependency_correction'` と `correction.blockedBy` で理由を残す。
 */
import { evaluateOperatingStatus } from '@/domain/operating-policy/schedule';
import {
  DEFAULT_TIMEZONE,
  addDaysToYmd,
  getZonedParts,
  ymdKey,
  zonedTimeToUtcMs,
} from '@/domain/operating-policy/tz';
import type { OperatingException, ServiceOperatingPolicy, TimeRange, Weekday } from '@/domain/operating-policy/types';
import {
  MANAGED_RUNTIME_SERVICES,
  type ManagedRuntimeService,
  type ManagedRuntimeServiceKey,
  type RuntimeCapability,
  type ServiceOperatingMode,
} from './registry';

/** サービスの解決済み稼働状態。`draining` は「進行中のみ継続・新規は受け付けない」。 */
export type ServiceRuntimeState = 'running' | 'stopped' | 'draining';

/** どの段で状態が決まったか（優先順位チェーンの段名 + 依存補正）。 */
export type ResolutionReason =
  | 'break_glass'
  | 'temporary_override'
  | 'exception_date'
  | 'custom_service_schedule'
  | 'common_weekly_schedule'
  | 'default_policy'
  | 'dependency_correction';

/** 一時 override（issue #367 本文の `temporaryOverride`）。 */
export type TemporaryOverride = {
  readonly state: 'force_running' | 'force_stopped' | 'draining';
  /** ISO8601。`expiresAt <= now` の評価時点で無視される（自動解除）。 */
  readonly expiresAt: string;
};

/** サービス単位のポリシー上書き（永続層の `ServiceOperatingPolicy` のうち解決に効く部分）。 */
export type ServicePolicyOverride = {
  readonly mode?: ServiceOperatingMode;
  /** サービス個別の週間スケジュール（空オブジェクトは「常時休止」を意味する）。 */
  readonly weeklySchedule?: Partial<Record<Weekday, readonly TimeRange[]>>;
  /** サービス個別の例外日（共通営業時間の例外日より優先する）。 */
  readonly exceptionDates?: readonly OperatingException[];
  readonly temporaryOverride?: TemporaryOverride;
};

/** 緊急全停止。`serviceKeys` 省略時は `BREAK_GLASS_PROTECTED_SERVICES` を除く全サービスが対象。 */
export type BreakGlassDirective = {
  readonly active: boolean;
  readonly serviceKeys?: readonly ManagedRuntimeServiceKey[];
};

/** 共通営業時間（既存 operating-policy のうち評価に使うフィールドだけ）。 */
export type CommonSchedule = Pick<
  ServiceOperatingPolicy,
  'timezone' | 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates'
>;

/** 解決の入力となる運用ポリシー一式。 */
export type RuntimeOperatingPolicy = {
  readonly commonSchedule: CommonSchedule;
  readonly breakGlass?: BreakGlassDirective;
  readonly services?: Readonly<Partial<Record<ManagedRuntimeServiceKey, ServicePolicyOverride>>>;
};

/** サービス 1 件の解決結果。 */
export type ServiceResolution = {
  readonly serviceKey: ManagedRuntimeServiceKey;
  /** 実効モード（override があればそれ、無ければ registry の既定）。 */
  readonly mode: ServiceOperatingMode;
  readonly state: ServiceRuntimeState;
  readonly reason: ResolutionReason;
  /** 依存整合で安全側へ倒したときだけ入る。 */
  readonly correction?: {
    readonly blockedBy: ManagedRuntimeServiceKey;
    readonly from: { readonly state: ServiceRuntimeState; readonly reason: ResolutionReason };
  };
};

/** 解決結果全体。`capabilities` は running のサービスが提供する能力の和（registry 順・重複なし）。 */
export type RuntimeStateResolution = {
  readonly services: readonly ServiceResolution[];
  readonly capabilities: readonly RuntimeCapability[];
};

/**
 * `breakGlass.serviceKeys` 省略時に停止対象から外すサービス。
 * 管理面と監視を巻き込んで止めると break-glass 自体を解除できず、状態も見えなくなるため
 * （運用者が明示的に `serviceKeys` へ挙げた場合は止められる）。
 */
export const BREAK_GLASS_PROTECTED_SERVICES: readonly ManagedRuntimeServiceKey[] = ['admin', 'monitoring'];

/** 安全側の強さ。大きいほど「動いていない」。依存補正では依存先の最大値まで落とす。 */
const SEVERITY: Record<ServiceRuntimeState, number> = { running: 0, draining: 1, stopped: 2 };

const OVERRIDE_STATE: Record<TemporaryOverride['state'], ServiceRuntimeState> = {
  force_running: 'running',
  force_stopped: 'stopped',
  draining: 'draining',
};

/** `evaluateOperatingStatus` に渡す合成ポリシーを作る（readonly 配列を可変配列へ写す）。 */
function scheduleFragment(
  timezone: string,
  weeklySchedule: Partial<Record<Weekday, readonly TimeRange[]>>,
  exceptionDates: readonly OperatingException[],
): CommonSchedule {
  const weekly: Partial<Record<Weekday, TimeRange[]>> = {};
  for (const [day, ranges] of Object.entries(weeklySchedule)) {
    if (ranges) weekly[day as Weekday] = [...ranges];
  }
  return { timezone, weeklySchedule: weekly, fixedHolidays: [], exceptionDates: [...exceptionDates] };
}

function evaluateToState(schedule: CommonSchedule, now: number): ServiceRuntimeState {
  return evaluateOperatingStatus(schedule, now).state === 'open' ? 'running' : 'stopped';
}

/**
 * `expiresAt` を**ポリシーのタイムゾーンで**解釈する。
 *
 * 🔴 `Date.parse` は ES 仕様上、オフセットの無い日時文字列を**ホストのローカル時刻**として
 * 読む。運用画面の `<input type="datetime-local">` は素直に作るとオフセットを持たない値
 * （`2026-07-22T12:00`）を送るので、Lambda(UTC) では「12:00 まで延長」が JST 21:00 まで
 * 生き残る。開発機(JST)で検証すると正しく見えるため、環境差でしか露見しない。
 * このモジュールの他の判定は全て IANA TZ を明示して使っているので、ここも揃える。
 */
export function expiresAtMs(expiresAt: string, timezone: string): number {
  /*
   * 🔴 **この関数は総関数にする。** Reconciler の毎分の解決から呼ばれるので、1 レコードの
   * 型ドリフト（旧データ・部分書き込み・DynamoDB の属性型違い）で throw すると**全サービスの
   * 解決が丸ごと落ち、何も収束しない**。文字列でない `expiresAt` も、不正な `timezone` も
   * 解析不能（NaN = 自動解除）として扱う。**解決全体はまだ総関数ではない**（`commonSchedule`
   * 欠落・非配列の `exceptionDates` などは throw する）。読み側の fail-safe は #798。
   */
  if (typeof expiresAt !== 'string') return Number.NaN;
  /*
   * 前後の空白は落とす。運用画面のコピー&ペーストで混ざるだけの違いを「解析不能 =
   * 一時 override が黙って効かない」に昇格させない。
   */
  const value = expiresAt.trim();
  /*
   * 🔴 **暦の妥当性は経路によらず先に見る。** `Date.parse` は月の桁溢れ（`13-01`）は拒むが
   * **日の桁溢れは通す**（`2026-02-30T00:00:00Z` → 3/2）。月末を機械生成する UI の
   * オフバイワンで、停止が最大 3 日延びる——画面は「2/30 まで」と読めるので気づけない。
   */
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!ymd || !isRealCalendarDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) return Number.NaN;
  /*
   * 🔴 時刻の妥当性も**経路によらず**先に見る。`Date.parse` は `24:00` を翌日として通すので、
   * 「`Z` を付けたら通る、付けなければ通らない」という説明できない差になっていた。
   * （オフセットの `+09:00` は `[T ]` が前置されないのでここには掛からない。）
   */
  const time = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? '0') > 59)) return Number.NaN;
  // オフセット付き（`Z` / `±HH:MM`）はそのまま絶対時刻として読める（小文字 `z` も同義に扱う）。
  if (hasAbsoluteOffset(value)) return Date.parse(value.replace(/z$/, 'Z'));
  /*
   * 🔴 **末尾まで縛る（`$`）。** 前方一致だと `2026-07-22T12:00oops` を「12:00 まで」と
   * 読んでしまい、doc の「解析不能は自動解除」と食い違う。黙って別の値として解釈しない。
   * 🔴 **秒も読む。** 落とすと `12:00:59` が `12:00:00` 扱いになり、最大 59 秒早く失効する。
   */
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
  if (!m) return Number.NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const seconds = m[6] === undefined ? 0 : Number(m[6]);
  /*
   * ミリ秒はオフセット付き（`.000Z`）だけ通って、オフセット無し（`.500`）は落ちる——という
   * 説明できない境界を作らない。`<input step="0.001">` と Luxon の
   * `toISO({ includeOffset: false })` がこの形を出す。`.5` は 500ms（右をゼロ埋め）。
   */
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  /*
   * 🔴 **暦として存在しない値を黙って読み替えない。** `Date` も `zonedTimeToUtcMs` も
   * `2026-13-45` を 2027 年へ、`99:99` を翌日以降へ繰り上げる。`force_stopped` と
   * 組み合わさると、月や時刻の 1 桁ミスが**数か月のサービス停止**として現れ、しかも
   * 画面上は「その日時まで」と読める。ここは doc の契約どおり「解析不能 = 自動解除」へ倒す。
   */
  // `zonedTimeToUtcMs` は分までしか受けないので、秒は後から足す（TZ オフセットは分単位で
  // 表現されるので、秒を加えても帯の判定はずれない）。
  /*
   * 🔴 `timezone` は `expiresAt` と**同じレコード・同じドリフト要因**で来る。`zonedTimeToUtcMs` は
   * 不正な IANA 名で RangeError を投げるので、ここも解析不能（= 自動解除）へ倒す。片方だけ塞いでも、
   * Reconciler が毎分同じ throw を繰り返す経路は消えない。
   * （解決全体の fail-safe——読み側で壊れたレコードをどう扱うか——は #798 の受入条件。）
   */
  try {
    return zonedTimeToUtcMs({ year, month, day, hour, minute }, timezone) + seconds * 1000 + millis;
  } catch {
    return Number.NaN;
  }
}

/** オフセット付き（`Z` / `±HH:MM`）か。付いていれば絶対時刻として読める。 */
function hasAbsoluteOffset(expiresAt: string): boolean {
  return /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(expiresAt.trim());
}

/**
 * 暦として存在する年月日か。`Date` は `2026-13-01` を 2027-01-01 へ、`2026-02-30` を 3/2 へ
 * 読み替えるので、`force_stopped` と組み合わさると桁のミスが数か月のサービス停止になる。
 *
 * 月がずれていれば日の桁溢れも月の桁溢れも両方掴める——桁数は正規表現で 2 桁に固定済みなので、
 * 日の溢れは必ず月を動かす。年の比較は `Date.UTC` が 0〜99 年を 1900 年代へ写すため。
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(asUtc.getTime())) return false;
  return asUtc.getUTCFullYear() === year && asUtc.getUTCMonth() === month - 1;
}

/** 期限内の一時 override だけを返す（期限切れ・解析不能は undefined = 自動解除）。 */
function activeTemporaryOverride(
  override: TemporaryOverride | undefined,
  timezone: string,
  now: number,
): TemporaryOverride | undefined {
  if (!override) return undefined;
  const expiresAt = expiresAtMs(override.expiresAt, timezone);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return override;
}

/** "HH:MM" を 0 時からの秒数へ。解析できなければ 0（＝持ち越しなしとして扱う）。 */
function timeToSeconds(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/**
 * その時刻に効いている例外日があるか。当日の例外に加えて、前日の日跨ぎ区間も持ち越しとして扱う
 * （持ち越しが無いと 22:00-02:00 の臨時営業が翌 01:00 に段ごと落ちてしまう）。
 *
 * 🔴 **持ち越しは「今が持ち越し区間の中か」まで見る。** 「前日に日跨ぎ区間が存在するか」だけで
 * 判定すると、翌日は終日この段に入る。段 3 は週間スケジュールを空にして評価するので、翌日には
 * 何の区間も無く**丸 1 日 stopped** になる（`realtime-conversation` に置けば音声受付が翌日
 * 営業時間内にまるごと死ぬ。しかも reason は `exception_date` という正当に見える値で返る）。
 */
function hasExceptionInEffect(exceptions: readonly OperatingException[], timezone: string, now: number): boolean {
  if (exceptions.length === 0) return false;
  const parts = getZonedParts(now, timezone);
  const todayKey = ymdKey(parts);
  const yesterdayKey = ymdKey(addDaysToYmd(parts, -1));
  const nowSeconds = parts.hour * 3600 + parts.minute * 60;
  return exceptions.some((exception) => {
    if (exception.date === todayKey) return true;
    if (exception.date !== yesterdayKey) return false;
    return (exception.ranges ?? []).some(
      (range) => range.crossesMidnight === true && nowSeconds < timeToSeconds(range.end),
    );
  });
}

/** break-glass の停止対象集合を決める。 */
function breakGlassTargets(
  directive: BreakGlassDirective | undefined,
  services: readonly ManagedRuntimeService[],
): ReadonlySet<ManagedRuntimeServiceKey> {
  if (!directive?.active) return new Set();
  // 🔴 **空配列を「対象なし」にしない。** 緊急停止は誤発火より**不発**のほうが害が大きい。
  // フォームで 1 件も選ばずに送られた `[]` を no-op にすると、UI は「停止しました」と出す
  // のに全サービスが動き続ける。省略と同じ（既定の保護対象以外を全停止）に倒す。
  if (directive.serviceKeys && directive.serviceKeys.length > 0) return new Set(directive.serviceKeys);
  return new Set(
    services.map((service) => service.serviceKey).filter((key) => !BREAK_GLASS_PROTECTED_SERVICES.includes(key)),
  );
}

/** 優先順位チェーンを 1 サービスへ適用する（依存補正はこの後段）。 */
function resolveSingleService(
  service: ManagedRuntimeService,
  policy: RuntimeOperatingPolicy,
  stopTargets: ReadonlySet<ManagedRuntimeServiceKey>,
  timezone: string,
  now: number,
): ServiceResolution {
  const override = policy.services?.[service.serviceKey];
  const mode = override?.mode ?? service.defaultMode;
  const base = { serviceKey: service.serviceKey, mode } as const;

  // 1. break-glass force stop
  if (stopTargets.has(service.serviceKey)) return { ...base, state: 'stopped', reason: 'break_glass' };

  // 2. temporary override（期限内のみ）
  const temporary = activeTemporaryOverride(override?.temporaryOverride, timezone, now);
  if (temporary) return { ...base, state: OVERRIDE_STATE[temporary.state], reason: 'temporary_override' };

  /*
   * 3・4 は**スケジュールで動くモードのときだけ**効かせる。
   *
   * issue #367 の優先順位は平坦なリストで、文面どおりに読むと段 3/4 は `mode` を見ない。
   * だが `mode` と `weeklySchedule` / `exceptionDates` は永続層で兄弟として持つので、
   * モードを切り替えたときに古い設定が残る。文面どおりだと:
   *
   * - `always_on` の `admin` が古い例外日で止まる。**管理コンソールが止まると、それを
   *   取り消すための操作ができない**（break-glass は `admin` を保護しているのに、
   *   例外日経由では無防備という非対称も残る）
   * - `manual_only` のサービスが残ったスケジュールで起動し続ける（EC2 ＝ AWS 実費）
   *
   * どちらも運用者の意図と逆なので、`always_on` / `manual_only` は段 3/4 を通さない。
   * これらを止めたいときは break-glass か temporaryOverride を使う（どちらも上位の段）。
   */
  const scheduleDriven = mode === 'follow_operating_hours' || mode === 'custom_schedule';

  // 3. exception date（サービス個別）
  const exceptions = override?.exceptionDates ?? [];
  if (scheduleDriven && hasExceptionInEffect(exceptions, timezone, now)) {
    return { ...base, state: evaluateToState(scheduleFragment(timezone, {}, exceptions), now), reason: 'exception_date' };
  }

  // 4. custom service schedule（サービス個別の週間スケジュール）
  if (scheduleDriven && override?.weeklySchedule !== undefined) {
    return {
      ...base,
      state: evaluateToState(scheduleFragment(timezone, override.weeklySchedule, []), now),
      reason: 'custom_service_schedule',
    };
  }

  // 5. common weekly schedule（共通営業時間に連動するモードのときだけ）
  if (mode === 'follow_operating_hours') {
    return { ...base, state: evaluateToState(policy.commonSchedule, now), reason: 'common_weekly_schedule' };
  }

  // 6. default policy（registry の既定モード）。always_on 以外は安全側の stopped。
  return { ...base, state: mode === 'always_on' ? 'running' : 'stopped', reason: 'default_policy' };
}

/**
 * 依存に反する組合せ（依存先が停止/縮退しているのに依存元が動いている）を安全側へ補正する。
 * registry の `dependsOn` は非循環なので、サービス数回の反復で不動点に達する。
 */
function applyDependencyCorrections(
  resolved: readonly ServiceResolution[],
  services: readonly ManagedRuntimeService[],
): ServiceResolution[] {
  const indexByKey = new Map(services.map((service, index) => [service.serviceKey, index]));
  const current = [...resolved];
  const beforeCorrection = resolved.map((resolution) => ({ state: resolution.state, reason: resolution.reason }));

  for (let pass = 0; pass <= services.length; pass++) {
    let changed = false;
    services.forEach((service, index) => {
      for (const dependency of service.dependsOn) {
        const dependencyIndex = indexByKey.get(dependency);
        if (dependencyIndex === undefined) continue; // registry に無い依存は無視する
        const self = current[index]!;
        const dependencyState = current[dependencyIndex]!.state;
        if (SEVERITY[dependencyState] <= SEVERITY[self.state]) continue;
        current[index] = {
          ...self,
          state: dependencyState,
          reason: 'dependency_correction',
          correction: { blockedBy: dependency, from: beforeCorrection[index]! },
        };
        changed = true;
      }
    });
    if (!changed) break;
  }
  return current;
}

/** running のサービスが提供する能力を registry 順で集約する（draining は提供しない）。 */
function collectCapabilities(
  services: readonly ManagedRuntimeService[],
  resolved: readonly ServiceResolution[],
): RuntimeCapability[] {
  const capabilities: RuntimeCapability[] = [];
  services.forEach((service, index) => {
    if (resolved[index]?.state !== 'running') return;
    for (const capability of service.provides) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
  });
  return capabilities;
}

/**
 * 全サービスの稼働状態と、そこから導かれる `RuntimeCapability` を解決する純関数。
 *
 * @param services 対象 registry（既定 `MANAGED_RUNTIME_SERVICES`）。テスト・将来のテナント別
 *   サブセットのために差し替え可能にしてある。registry に無い serviceKey の override は無視する。
 * @param now 評価時刻（epoch ms、既定 `Date.now()`）。
 */
export function resolveServiceStates({
  policy,
  services = MANAGED_RUNTIME_SERVICES,
  now = Date.now(),
}: {
  policy: RuntimeOperatingPolicy;
  services?: readonly ManagedRuntimeService[];
  now?: number;
}): RuntimeStateResolution {
  const timezone = policy.commonSchedule.timezone || DEFAULT_TIMEZONE;
  const stopTargets = breakGlassTargets(policy.breakGlass, services);
  const resolved = services.map((service) => resolveSingleService(service, policy, stopTargets, timezone, now));
  const corrected = applyDependencyCorrections(resolved, services);
  return { services: corrected, capabilities: collectCapabilities(services, corrected) };
}

/** 解決結果から 1 サービスを引く。未知キーは undefined。 */
export function resolutionFor(
  resolution: RuntimeStateResolution,
  serviceKey: ManagedRuntimeServiceKey,
): ServiceResolution | undefined {
  return resolution.services.find((service) => service.serviceKey === serviceKey);
}
