/**
 * runtime policy の入力検証 (#367)。
 *
 * 🔴 **Reconciler は 1 分ごとに走る。** 解決が throw すると「何も収束しないまま繰り返す」
 * ——EC2 が上がりっぱなし、あるいは上がらないまま、どちらにも倒れうる。壊れた入力は
 * 永続層へ入る前に止める。
 *
 * **再実装しない。** スケジュール・例外日・件数上限・重複・日跨ぎの契約は既存の
 * `validatePolicyInput`（`operating-policy/schedule.ts`）が正本なので、そこへ委譲して
 * issue のフィールド名だけ付け替える。独自に書き直したところ、共通側と契約がずれて
 * （`crossesMidnight` の向き・件数上限の欠落）**サービスが 24 時間 running になる**
 * 経路を作っていた。
 */
import { validatePolicyInput } from '@/domain/operating-policy/schedule';
import type { PolicyValidationIssue } from '@/domain/operating-policy/types';
import {
  MANAGED_RUNTIME_SERVICES,
  MANAGED_RUNTIME_SERVICE_KEYS,
  type ManagedRuntimeServiceKey,
  type ServiceOperatingMode,
} from './registry';
import {
  expiresAtMs,
  type CommonSchedule,
  type RuntimeOperatingPolicy,
  type ServicePolicyOverride,
  type TemporaryOverride,
} from './resolve';

export type RuntimePolicyValidation =
  | { ok: true; value: RuntimeOperatingPolicy }
  | { ok: false; error: { code: 'invalid_input'; message: string; issues: PolicyValidationIssue[] } };

const MODES = ['always_on', 'follow_operating_hours', 'custom_schedule', 'manual_only'] as const;
const OVERRIDE_STATES = ['force_running', 'force_stopped', 'draining'] as const;
// 集合が union からずれたらコンパイルで落ちる（文字列リテラルの複製を放置しない）。
const _MODES: readonly ServiceOperatingMode[] = MODES;
const _STATES: readonly TemporaryOverride['state'][] = OVERRIDE_STATES;

/*
 * ここへ来るのは JSON.parse を通った値だけなので、**素のオブジェクトだけ**を通す。
 * `typeof === 'object'` だけだと `new Date()` のような「キーを持たないオブジェクト」が通り、
 * 委譲先で既定（空スケジュール）へ倒れて保存される。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isManagedKey(value: unknown): value is ManagedRuntimeServiceKey {
  return typeof value === 'string' && (MANAGED_RUNTIME_SERVICE_KEYS as readonly string[]).includes(value);
}

/*
 * 🔴 **未知キーは黙って捨てず issue にする。** allow-list で組み立て直すだけでは
 * 「余計なものを保存しない」しか担保できず、「余計なものを送ったと運用者へ知らせる」は
 * 担保されない。`temporaryOveride`（1 文字 typo）で API が 200 を返し、画面は「停止しました」と
 * 出し、EC2 は動き続ける——著者自身が 1 階層上で名指しした失敗が、内側では起きていた。
 *
 * 既知キーは `Record<keyof T, true>` で持つ。型にキーが増減したらコンパイルで落ちる
 * （文字列リテラルの一覧が型から遅れると、新フィールドが「未知キー」として拒否される）。
 */
const POLICY_FIELDS: Record<keyof RuntimeOperatingPolicy, true> = {
  commonSchedule: true,
  breakGlass: true,
  services: true,
};
/*
 * 🔴 **封筒フィールドをここで「既知だが無視」にしない。** 一度そうしたが、隣接する
 * `operating-policy` の body は**平たい**（`timezone` / `weeklySchedule` が最上位）ので、
 * 封筒を許しても互換にはならない——実測で 6 件の issue が出て通らない。得るものが無い一方、
 * `expectedVersion` を**黙って捨てる**形になり、`validated.value` だけを見る route を書いた
 * 瞬間に競合更新が後勝ちで上書きされる（同じ関数内で `emergencyContactLabel` は
 * 「捨てずに拒否」と決めているのに、原則が反転する）。封筒は route が剥がして渡す（#798）。
 */

/*
 * 共通営業時間で**この層が組み立て直す**フィールド。`emergencyContactLabel` は含めない——
 * 委譲先は受け付けるが、この層は返さないので、通すと**無言で消える**。それは営業時間外画面で
 * 来訪者へ出す唯一の連絡先なので、捨てずに拒否して気づかせる。
 */
const COMMON_SCHEDULE_FIELDS: Record<keyof CommonSchedule, true> = {
  timezone: true,
  weeklySchedule: true,
  fixedHolidays: true,
  exceptionDates: true,
};
const OVERRIDE_FIELDS: Record<keyof ServicePolicyOverride, true> = {
  mode: true,
  weeklySchedule: true,
  exceptionDates: true,
  temporaryOverride: true,
};
const TEMPORARY_FIELDS: Record<keyof TemporaryOverride, true> = { state: true, expiresAt: true };
const BREAK_GLASS_FIELDS: Record<keyof NonNullable<RuntimeOperatingPolicy['breakGlass']>, true> = {
  active: true,
  serviceKeys: true,
};

/*
 * 未知キーは 1 件ずつ issue にする（どれが効いていないかを名指しできないと直せない）。
 * ただし**件数は打ち切る**——`services` のキー数だけ抑えても、その内側が無制限なら
 * 20 万キーの body で応答が膨らむ経路は残る。打ち切ったことは黙らず 1 行で表明する。
 */
const MAX_REPORTED_UNKNOWN_FIELDS = 5;

function rejectUnknownFields(
  value: Record<string, unknown>,
  known: Record<string, true>,
  prefix: string,
  issues: PolicyValidationIssue[],
): void {
  let reported = 0;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(known, key)) continue;
    if (reported === MAX_REPORTED_UNKNOWN_FIELDS) {
      issues.push({
        field: prefix,
        message: `too many unknown fields (first ${MAX_REPORTED_UNKNOWN_FIELDS} reported)`,
      });
      return;
    }
    issues.push({ field: `${prefix}.${safeFieldKey(key)}`, message: 'unknown field' });
    reported += 1;
  }
}

const MAX_FIELD_KEY_LENGTH = 64;

/*
 * `\p{C}` は U+2028 / U+2029（Zl/Zp）を含まないが、JS の LineTerminator であり
 * `JSON.stringify` もエスケープしない。行注入としては改行と同じなので一緒に落とす。
 */
function stripLineBreakers(value: string): string {
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '·');
}

/**
 * issue の `field` へ載せる入力キーを丸めて無害化する。逐語で載せると、改行入りのキーが
 * 構造化ログへ偽イベント行として流れ、長大なキーがそのままレスポンスを膨らませる。
 */
function safeFieldKey(key: string): string {
  const cleaned = stripLineBreakers(key);
  if (cleaned.length <= MAX_FIELD_KEY_LENGTH) return cleaned;
  // 先頭だけ残すと、同じ前置を持つ 2 つのキーが同じ `field` に潰れて特定できなくなる。
  return `${cleaned.slice(0, MAX_FIELD_KEY_LENGTH - 16)}…${cleaned.slice(-16)}`;
}

/*
 * 管理対象サービスは registry で 10 件に固定されている。それを超える入力は必ず誤りなので、
 * 1 件ずつ issue にせず 1 行で打ち切る（20 万キーの body で 20MB の応答を作らせない）。
 */
const MAX_SERVICE_ENTRIES = MANAGED_RUNTIME_SERVICE_KEYS.length;
/*
 * 打ち切りは登録数**ちょうどでは早すぎる**。10 サービス全部 + typo 1 件で「too many entries」しか
 * 返らず、どれが typo か示せない——「typo を黙って捨てない」という目的と噛み合わない。
 */
const MAX_SERVICE_INPUT_ENTRIES = MAX_SERVICE_ENTRIES * 2;

/**
 * 共通 validator の issue を、この階層のフィールド名へ付け替える。
 *
 * 🔴 **委譲先の `field` も無害化する。** 委譲先は入力キーを逐語で載せるので、前置きを足すだけだと
 * 改行入りのキーが構造化ログへ偽イベント行として流れ、2 万文字のキーが 1MB の応答を作れる。
 * 自前の経路だけ `safeFieldKey` を掛けても意味がない。
 */
function reprefix(issues: readonly PolicyValidationIssue[], prefix: string): PolicyValidationIssue[] {
  return issues.map((issue) => ({ ...issue, field: safeFieldPath(`${prefix}.${issue.field}`) }));
}

const MAX_FIELD_PATH_LENGTH = 128;

/** パス全体を無害化して丸める（セグメント単位に分けない——キー自身が `.` を含みうる）。 */
function safeFieldPath(path: string): string {
  const cleaned = stripLineBreakers(path);
  if (cleaned.length <= MAX_FIELD_PATH_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_FIELD_PATH_LENGTH - 25)}…${cleaned.slice(-24)}`;
}

export function validateRuntimePolicyInput(raw: unknown): RuntimePolicyValidation {
  if (!isRecord(raw)) {
    return fail([{ field: 'body', message: 'must be an object' }]);
  }
  const issues: PolicyValidationIssue[] = [];
  /*
   * ここが受け取るのは**ポリシー文書そのもの**。`expectedVersion` のような route 層の
   * 封筒フィールドは route が剥がしてから渡す。逆に言えば、この階層の未知キーは
   * 打ち間違い（`servcies`）か、永続層の管理フィールドを混ぜる試み（`version` /
   * `updatedBy`）のどちらかしかない。前者は「設定したのに効かない」、後者は楽観ロックと
   * 監査の破壊なので、どちらも黙って捨てずに issue にする。
   */
  rejectUnknownFields(raw, POLICY_FIELDS, 'root', issues);

  /*
   * 🔴 **配列を先に落とす。** 委譲先の門は `typeof raw !== 'object' || raw === null` だけなので
   * `[]` を通し、既定（空スケジュール）へ倒れる。それが保存されると音声受付・AI 意図解決・
   * 外線発信が全滅し（残るのは notify_staff だけ）、`reason` は `common_weekly_schedule` という
   * 正当に見える値で返る。この層は `isRecord` を持っているのに、ここだけ使っていなかった。
   */
  let commonSchedule: CommonSchedule | undefined;
  if (!isRecord(raw.commonSchedule)) {
    /*
     * ここで即 return すると `breakGlass` / `services` の問題が 1 件も返らず、新規作成時に
     * 往復が増える。`commonSchedule` は undefined のまま先へ進めて、まとめて報告する。
     */
    issues.push({ field: 'commonSchedule', message: 'commonSchedule is required and must be an object' });
  } else {
    rejectUnknownFields(raw.commonSchedule, COMMON_SCHEDULE_FIELDS, 'commonSchedule', issues);
    validateCommonSchedule(raw.commonSchedule, issues, (value) => {
      commonSchedule = value;
    });
  }

  const breakGlass = validateBreakGlass(raw.breakGlass, issues);
  const services = validateServices(raw.services, issues);

  if (issues.length > 0 || commonSchedule === undefined) return fail(issues);

  /*
   * 🔴 **入力オブジェクトをそのまま返さない。** 検証したフィールドだけを組み立て直す。
   * 素通しにすると未知キーが残り、永続層へ繋いだ瞬間にクライアントが `version` /
   * `updatedBy` / `tenantId` を body に混ぜられる mass-assignment 経路になる
   * （楽観ロックと監査の両方を壊せる）。
   */
  return {
    ok: true,
    value: {
      commonSchedule,
      ...(breakGlass ? { breakGlass } : {}),
      ...(services ? { services } : {}),
    },
  };
}

/*
 * 🔴 **issue の総数を打ち切る。** 階層ごとの上限だけでは、委譲先が出す issue（例外日 366 件 ×
 * サービス 10 件）まで含めた総量を抑えられない。認証済み admin の誤った body で Lambda の応答が
 * 数 MB になり、管理画面が固まり、CloudWatch へ同量が流れる。打ち切ったことは黙らず表明する。
 */
/*
 * 応答が入力に比例して膨らまないための上限は**2 つで足りる**——1 issue の大きさ（`field` は
 * `safeFieldPath` で 128 文字、`message` はこのモジュールと委譲先の定数のみ）と、issue の件数。
 * 別途バイト予算も置いていたが、この 2 つがある限り観測できない冗長分岐だったので外した。
 */
const MAX_ISSUES = 50;

/**
 * 報告する issue を絞る。**末尾切りにしない**——`commonSchedule` の issue が先に積まれるので、
 * 単純に前から取ると `services` の typo が 1 件も返らず、運用者は直すたびに次が現れる。
 * 階層（`field` の先頭セグメント）ごとに順番に取り、打ち切ったことは黙らず表明する。
 */
function limitIssues(issues: PolicyValidationIssue[]): PolicyValidationIssue[] {
  // 上限未満のときの早道は置かない——選抜後に入力順へ戻すので結果が同じで、**殺せない分岐**になる。
  const bySection = new Map<string, number[]>();
  issues.forEach((issue, index) => {
    // `field` は必ず `root|commonSchedule|breakGlass|services|body` で始まる（キー由来の `.` は
    // 2 番目以降にしか出ない）ので、攻撃者がセクションを増やして予算を薄めることはできない。
    const section = issue.field.split('.')[0] ?? issue.field;
    const bucket = bySection.get(section);
    if (bucket) bucket.push(index);
    else bySection.set(section, [index]);
  });
  const queues = [...bySection.values()];
  const keptIndexes: number[] = [];
  let drained = false;
  while (!drained && keptIndexes.length < MAX_ISSUES) {
    drained = true;
    for (const queue of queues) {
      const next = queue.shift();
      if (next === undefined) continue;
      drained = false;
      keptIndexes.push(next);
      if (keptIndexes.length >= MAX_ISSUES) break;
    }
  }
  /*
   * **選ぶ**のは階層をまたいで均等に、**返す**のは入力の順序で。常にインターリーブして返すと、
   * issue 順にエラーを並べる画面で無関係な行が交互に出る（隣接 route は文書順を返す）。
   */
  const kept = keptIndexes.sort((a, b) => a - b).map((index) => issues[index]!);
  const dropped = issues.length - kept.length;
  if (dropped > 0) kept.push({ field: 'body', message: `too many issues; ${dropped} more not reported` });
  return kept;
}

/** 共通営業時間は丸ごと既存 validator へ。**正規化済みの値を使う**（素通しにしない）。 */
function validateCommonSchedule(
  raw: Record<string, unknown>,
  issues: PolicyValidationIssue[],
  accept: (value: CommonSchedule) => void,
): void {
  const common = validatePolicyInput(raw);
  if (!common.ok) {
    issues.push(...reprefix(common.error.issues, 'commonSchedule'));
    if (common.error.issues.length === 0) {
      // 委譲するのは契約であって文言ではない。委譲元は「body must be an object」と言うが、
      // ここでの body は正しいオブジェクトで、足りないのは `commonSchedule` の方。
      issues.push({ field: 'commonSchedule', message: 'commonSchedule is required and must be an object' });
    }
    return;
  }
  const { timezone, weeklySchedule, fixedHolidays, exceptionDates } = common.value;
  accept({ timezone, weeklySchedule, fixedHolidays, exceptionDates });
}

function fail(issues: PolicyValidationIssue[]): RuntimePolicyValidation {
  const reported = limitIssues(issues);
  return { ok: false, error: { code: 'invalid_input', message: 'runtime policy is invalid', issues: reported } };
}

function validateBreakGlass(
  value: unknown,
  issues: PolicyValidationIssue[],
): RuntimeOperatingPolicy['breakGlass'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ field: 'breakGlass', message: 'must be an object' });
    return undefined;
  }
  rejectUnknownFields(value, BREAK_GLASS_FIELDS, 'breakGlass', issues);
  if (typeof value.active !== 'boolean') {
    issues.push({ field: 'breakGlass.active', message: 'must be a boolean' });
  }
  const keys = value.serviceKeys;
  if (keys === undefined) {
    return typeof value.active === 'boolean' ? { active: value.active } : undefined;
  }
  if (!Array.isArray(keys)) {
    issues.push({ field: 'breakGlass.serviceKeys', message: 'must be an array' });
    return undefined;
  }
  /*
   * 上限 10 は**重複を畳んだ後**の数。畳まずに数えると、実質 2 サービスの緊急停止が
   * 「too many entries」で 400 になる——不発の害が最も大きい経路で。
   */
  const unique = Array.from(new Set(keys));
  if (unique.length > MAX_SERVICE_INPUT_ENTRIES) {
    issues.push({
      field: 'breakGlass.serviceKeys',
      message: `too many distinct entries (max ${MAX_SERVICE_INPUT_ENTRIES})`,
    });
    return undefined;
  }
  /*
   * issue の位置は**入力の位置**を指す。畳んだ後の index を返すと、緊急停止の設定画面が
   * 誤った要素をハイライトする——急いで叩く操作でさらに迷わせることになる。保存するのは畳んだ値。
   */
  keys.forEach((key, index) => {
    if (!isManagedKey(key)) {
      issues.push({ field: `breakGlass.serviceKeys[${index}]`, message: 'unknown service key' });
    }
  });
  const serviceKeys = unique.filter(isManagedKey);
  return typeof value.active === 'boolean' ? { active: value.active, serviceKeys } : undefined;
}

function validateServices(
  value: unknown,
  issues: PolicyValidationIssue[],
): RuntimeOperatingPolicy['services'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ field: 'services', message: 'must be an object' });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SERVICE_INPUT_ENTRIES) {
    issues.push({ field: 'services', message: `too many entries (max ${MAX_SERVICE_INPUT_ENTRIES})` });
    return undefined;
  }
  const services: Partial<Record<ManagedRuntimeServiceKey, ServicePolicyOverride>> = {};
  for (const [key, override] of entries) {
    // 🔴 未知のキーを黙って無視しない。typo は「設定したのに効かない」として現れる。
    if (!isManagedKey(key)) {
      issues.push({ field: `services.${safeFieldKey(key)}`, message: 'unknown service key' });
      continue;
    }
    if (!isRecord(override)) {
      issues.push({ field: `services.${key}`, message: 'must be an object' });
      continue;
    }
    const validated = validateOverride(key, override, issues);
    if (validated) services[key] = validated;
  }
  return services;
}

/*
 * 「共通へ戻す」は `follow_operating_hours`、「止め続ける」は `manual_only`。区間ゼロの
 * スケジュールは**どちらでもない恒久停止**を作り、`reason` は `custom_service_schedule` という
 * 正当に見える値で返るので気づけない。助言は mode まで含めて書く。
 */
/**
 * registry の既定 mode（入力が mode を省いたときに実際に効く値）。
 * registry の全キーから作るので欠けは無い（`registry.test.ts` が一覧と一意性を固定している）。
 * `Map` + `??` にすると、到達しないフォールバックという**殺せない分岐**が 1 つ増える。
 */
const DEFAULT_MODE_BY_KEY = Object.fromEntries(
  MANAGED_RUNTIME_SERVICES.map((service) => [service.serviceKey, service.defaultMode]),
) as Record<ManagedRuntimeServiceKey, ServiceOperatingMode>;

/*
 * `always_on` / `manual_only` は解決の段 3/4 を通さないので、スケジュールを設定しても
 * **黙って無視される**——本 PR が塞いだ typo と同じ「設定したのに効かない」体験になる。
 */
const IGNORED_SCHEDULE_MESSAGE =
  'is ignored unless mode is follow_operating_hours or custom_schedule; set one of those to limit when this service runs';

const EMPTY_SCHEDULE_MESSAGE =
  'must contain at least one time range (or set exceptionDates); omit this key and set mode to follow_operating_hours to inherit the common schedule, or use manual_only to keep the service stopped';

/** 区間を 1 つでも持つか（`{}` も `{ mon: [] }` も「恒久停止」という同じ意味になる）。 */
function hasAnyRange(schedule: Record<string, unknown>): boolean {
  return Object.values(schedule).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
}

function validateOverride(
  key: ManagedRuntimeServiceKey,
  override: Record<string, unknown>,
  issues: PolicyValidationIssue[],
): ServicePolicyOverride | undefined {
  const before = issues.length;
  rejectUnknownFields(override, OVERRIDE_FIELDS, `services.${key}`, issues);
  const result: {
    mode?: ServiceOperatingMode;
    weeklySchedule?: CommonSchedule['weeklySchedule'];
    exceptionDates?: CommonSchedule['exceptionDates'];
    temporaryOverride?: TemporaryOverride;
  } = {};

  const mode = override.mode;
  if (mode !== undefined) {
    if (!(MODES as readonly string[]).includes(mode as string)) {
      issues.push({ field: `services.${key}.mode`, message: `must be one of ${MODES.join(' | ')}` });
    } else {
      result.mode = mode as ServiceOperatingMode;
    }
  }

  /** 実際に効く mode（明示 > registry 既定）。判定はすべてこれで行う。 */
  const effectiveMode = result.mode ?? DEFAULT_MODE_BY_KEY[key];
  const scheduleDriven = effectiveMode === 'follow_operating_hours' || effectiveMode === 'custom_schedule';
  /*
   * 🔴 「例外日が**あるか**」ではなく「**開ける**例外日があるか」。休業（`closed: true`）の
   * 例外日で守りを外すと、区間ゼロとの組み合わせが「1 年中 stopped」になり、しかも
   * `reason` は `exception_date` という正当に見える値で返る。
   * `closed` の省略は委譲先が false（＝ ranges 必須の臨時営業）として扱うので、開ける側に数える。
   */
  const hasOpeningException =
    Array.isArray(override.exceptionDates) &&
    override.exceptionDates.some((exception) => isRecord(exception) && exception.closed !== true);
  /*
   * mode 自体が不正なら、**推測した既定 mode を前提にした助言をしない**（typo を直せば
   * 前提が変わる）。`manual-only` の打ち間違いに「区間を 1 つ以上入れよ」と言い、直したら
   * 今度は「無視される」と言う——往復が 1 回増えるだけで、どちらの助言も嘘になる。
   */
  const modeIsValid = override.mode === undefined || result.mode !== undefined;

  /*
   * 🔴 `custom_schedule` なのにスケジュールも例外日も無いと、解決は段 3・段 4 を素通りして
   * `default_policy` で **stopped** になる。「キーを省略せよ」という助言だけを載せていた頃は、
   * **メッセージ自身が事故を誘発していた**（共通営業時間へ戻したつもりが恒久停止）。
   */
  /*
   * ここに `modeIsValid` は要らない。registry の既定 mode に `custom_schedule` は無いので
   * （`registry.test.ts` が固定）、mode が不正なときに `effectiveMode` が `custom_schedule` に
   * なることはない＝到達しない分岐を増やすだけになる。
   */
  if (effectiveMode === 'custom_schedule' && override.weeklySchedule === undefined && !hasOpeningException) {
    issues.push({ field: `services.${key}.weeklySchedule`, message: EMPTY_SCHEDULE_MESSAGE });
  }

  const temporary = override.temporaryOverride;
  if (temporary !== undefined) {
    const validated = validateTemporaryOverride(key, temporary, issues);
    if (validated) result.temporaryOverride = validated;
  }

  /*
   * スケジュールを読まない mode に設定させない。mode の省略時は registry の既定が効くので、
   * 判定も**実際に効く mode**（明示 > registry 既定）で行う。
   */
  if (!scheduleDriven && modeIsValid) {
    for (const field of ['weeklySchedule', 'exceptionDates'] as const) {
      if (override[field] !== undefined) {
        issues.push({ field: `services.${key}.${field}`, message: IGNORED_SCHEDULE_MESSAGE });
      }
    }
  }

  /*
   * サービス個別のスケジュール・例外日も共通 validator へ通す。ここを素通しにしていたため、
   * `services.<key>.exceptionDates` が**どんな形でも通り**、解決が TypeError で落ちていた。
   */
  if (override.weeklySchedule !== undefined || override.exceptionDates !== undefined) {
    /*
     * 🔴 **`?? {}` で潰さない。** 共通側は `weeklySchedule: null` を弾くのに、ここだけ `{}` へ
     * 潰していた。`{}` は解決では「区間ゼロ = 恒久 stopped」なので、運用画面の「個別設定を
     * クリア」（フォーム系が素直に送るのは `null`）が realtime-conversation を営業時間内も
     * 永久停止させ、`reason` は `custom_service_schedule` という正当に見える値で返っていた。
     * 「共通営業時間へ戻す」はキーの省略で表す（`undefined` は委譲先が既定へ倒す）。
     */
    /*
     * 🔴 **空オブジェクトも拒否する。** `null` を塞いだだけでは足りない。行を全部消した
     * フォームが素直に作る `{}` は、解決では「区間ゼロ = 恒久 stopped」になり、`mode` を
     * `follow_operating_hours` へ戻しても段 4 が段 5 を上書きするので共通営業時間へ戻らない。
     */
    /*
     * 🔴 **例外日があるなら区間ゼロは正当。** 「普段は停止、展示会の日だけ稼働」は解決の段 3
     * （`exception_date`）が今も正しく扱う構成で、一律に弾いていたときは費用最適化の設定が
     * 保存できなくなっていた。しかも当時のメッセージが勧める `manual_only` は段 3 を素通りする
     * ので、助言に従うと**例外日が黙って死ぬ**。区間ゼロを咎めるのは、例外日も無いときだけ。
     */
    if (modeIsValid && scheduleDriven && !hasOpeningException && isRecord(override.weeklySchedule) && !hasAnyRange(override.weeklySchedule)) {
      issues.push({ field: `services.${key}.weeklySchedule`, message: EMPTY_SCHEDULE_MESSAGE });
    }
    const nested = validatePolicyInput({
      timezone: 'UTC',
      weeklySchedule: override.weeklySchedule,
      fixedHolidays: [],
      exceptionDates: override.exceptionDates,
    });
    if (!nested.ok) {
      issues.push(...reprefix(nested.error.issues, `services.${key}`));
      if (nested.error.issues.length === 0) {
        issues.push({ field: `services.${key}`, message: nested.error.message });
      }
    } else {
      if (override.weeklySchedule !== undefined) result.weeklySchedule = nested.value.weeklySchedule;
      if (override.exceptionDates !== undefined) result.exceptionDates = nested.value.exceptionDates;
    }
  }

  /*
   * issue が 1 つでも積まれれば全体が `fail` になるので、ここで返した値は使われない。
   * それでも「壊れた override を組み立てたまま返す」形は残さない（呼び出し側が将来
   * 部分成功を許した瞬間に、検証を通っていない値が混ざる）。
   */
  return issues.length === before ? result : undefined;
}

function validateTemporaryOverride(
  key: ManagedRuntimeServiceKey,
  value: unknown,
  issues: PolicyValidationIssue[],
): TemporaryOverride | undefined {
  const field = `services.${key}.temporaryOverride`;
  if (!isRecord(value)) {
    issues.push({ field, message: 'must be an object' });
    return undefined;
  }
  rejectUnknownFields(value, TEMPORARY_FIELDS, field, issues);
  const state = value.state;
  if (!(OVERRIDE_STATES as readonly string[]).includes(state as string)) {
    issues.push({ field: `${field}.state`, message: `must be one of ${OVERRIDE_STATES.join(' | ')}` });
  }
  const expiresAt = value.expiresAt;
  if (typeof expiresAt !== 'string' || !isResolvableExpiresAt(expiresAt)) {
    issues.push({ field: `${field}.expiresAt`, message: 'must be a resolvable ISO8601 date or date-time' });
  }
  if (!(OVERRIDE_STATES as readonly string[]).includes(state as string) || typeof expiresAt !== 'string') {
    return undefined;
  }
  // 検証だけ trim して生値を保存すると、改行込みの値が DynamoDB → 応答 → 画面 → 監査へ流れ、
  // `expiresAtMs` を通らない消費者（画面の `new Date()`・TTL 計算・ログ）が別の結果になる。
  return { state: state as TemporaryOverride['state'], expiresAt: expiresAt.trim() };
}

/**
 * `expiresAt` は**実際のパーサ**（`expiresAtMs`）だけで確かめる。判定を 2 本持つと受理集合が
 * ずれ、「検証を通ったのに解決時に NaN」や、その逆（`toISOString()` の出力を拒否する）が
 * 起きる。暦のロールオーバー（`2026-13-01` → 2027-01-01）の拒否もパーサ側の責務。
 */
function isResolvableExpiresAt(value: string): boolean {
  // タイムゾーンは**解析できるか**の判定には効かない（オフセットが変わるだけ）。ポリシー側の
  // TZ をここへ引き回すと、TZ が無効な入力で「期限も無効」と二重に落ちて原因が読めなくなる。
  return Number.isFinite(expiresAtMs(value, 'UTC'));
}
