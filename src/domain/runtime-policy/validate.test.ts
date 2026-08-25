import { describe, expect, it } from 'vitest';
import { MANAGED_RUNTIME_SERVICE_KEYS } from './registry';
import { resolveServiceStates } from './resolve';
import { validateRuntimePolicyInput } from './validate';

const NOW = Date.parse('2026-07-22T01:00:00Z');
const OK = {
  commonSchedule: {
    timezone: 'Asia/Tokyo',
    weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    fixedHolidays: [],
    exceptionDates: [],
  },
};

function issuesOf(raw: unknown): string[] {
  const result = validateRuntimePolicyInput(raw);
  return result.ok ? [] : result.error.issues.map((i) => i.field);
}

/** 文言も固定する。`field` しか見ないと「何と言って弾いたか」の変異が生き残る。 */
function messagesOf(raw: unknown): string[] {
  const result = validateRuntimePolicyInput(raw);
  return result.ok ? [] : result.error.issues.map((i) => i.message);
}

describe('runtime policy の入力検証 (#367)', () => {
  it('正しい入力は通り、解決へそのまま渡せる', () => {
    const result = validateRuntimePolicyInput(OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => resolveServiceStates({ policy: result.value, now: NOW })).not.toThrow();
    }
  });

  it('オブジェクトでない入力を弾く', () => {
    for (const bad of [null, undefined, 'x', 1, []]) {
      expect(validateRuntimePolicyInput(bad).ok, String(bad)).toBe(false);
      // issues が空だと、フィールド脇に理由を出す画面が「何も言わずに失敗」になる。
      // `body`（文書そのもの）と `root.<key>`（トップ階層のフィールド）は別物として名付ける。
      expect(issuesOf(bad), String(bad)).toContain('body');
    }
  });

  it('commonSchedule に配列・Date を通さない（委譲先は配列を通す）', () => {
    /*
     * 🔴 委譲先 `validatePolicyInput` の門は `typeof raw !== 'object' || raw === null` だけで、
     * **配列を通す**。`{ commonSchedule: [] }` が既定へ倒れて保存されると、音声受付・AI 意図解決・
     * 外線発信が全滅し（残るのは notify_staff だけ）、`reason` は `common_weekly_schedule` という
     * 正当に見える値で返る。この層は `isRecord` を持っているのに、ここだけ使っていなかった。
     */
    for (const bad of [[], [1, 2, 3], new Date(), 'x', null]) {
      expect(issuesOf({ commonSchedule: bad }), JSON.stringify(bad)).toContain('commonSchedule');
    }
  });

  it('commonSchedule の未知キーも黙って捨てない（emergencyContactLabel を無言で消さない）', () => {
    /*
     * 🔴 `emergencyContactLabel` は営業時間外画面で**来訪者への唯一の頼れる連絡先**として出る値。
     * この層は 4 フィールドしか組み立て直さないので、runtime policy 経由で共通営業時間を書くと
     * **無言で消える**。この層が管理しないなら、捨てるのではなく拒否して気づかせる。
     */
    expect(issuesOf({ ...OK, commonSchedule: { ...OK.commonSchedule, emergencyContactLabel: '内線 1234' } })).toContain(
      'commonSchedule.emergencyContactLabel',
    );
    expect(issuesOf({ ...OK, commonSchedule: { ...OK.commonSchedule, typoKey: 1 } })).toContain(
      'commonSchedule.typoKey',
    );
  });

  it('route 層の封筒フィールドは通し、永続層の管理フィールドは拒否する', () => {
    /*
     * 隣接する `operating-policy` の route/store は `tenantId` / `siteId` / `expectedVersion` を
     * **同じ body に載せて** validator へ渡す（`src/lib/operating-policy/store.ts`）。この層が
     * それを未知キーとして弾くと、繋いだ瞬間に全リクエストが 400 になる。封筒は既知として
     * 受け取り、**文書には入れない**。一方 `version` / `updatedBy` は封筒ではないので拒否する。
     */
    const result = validateRuntimePolicyInput({ ...OK, tenantId: 't1', siteId: 's1', expectedVersion: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value)).toEqual(['commonSchedule']);
    expect(issuesOf({ ...OK, version: 99 })).toContain('root.version');
  });

  it('commonSchedule の欠落を自分の言葉で説明する（委譲元の文言を漏らさない）', () => {
    // 委譲するのは契約であって文言ではない。body は正しいオブジェクトなのに
    // 「body must be an object」と返ると、運用者は何を直せばよいか分からない。
    for (const bad of [{}, { commonSchedule: null }, { commonSchedule: 'x' }]) {
      const result = validateRuntimePolicyInput(bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const message = result.error.issues.find((i) => i.field === 'commonSchedule')?.message ?? '';
      expect(message).toContain('commonSchedule');
    }
  });

  /**
   * 🔴 Reconciler は 1 分ごとに走る。解決が throw すると**何も収束しないまま繰り返す**
   * （EC2 が上がりっぱなし／上がらないまま）。実測で、非空の不正 timezone は
   * `RangeError` を投げる（空文字は既定へ倒れて救われる）。検証で止める。
   */
  it('不正な timezone を弾く（解決に到達させない）', () => {
    expect(issuesOf({ ...OK, commonSchedule: { ...OK.commonSchedule, timezone: 'Asia/Tokyoo' } })).toContain(
      'commonSchedule.timezone',
    );
    // 空文字は既定へ倒れるので通してよい（既存挙動）。
    expect(validateRuntimePolicyInput({ ...OK, commonSchedule: { ...OK.commonSchedule, timezone: '' } }).ok).toBe(true);
  });

  it('未知のサービスキーを弾く（typo が黙って無視されない）', () => {
    expect(issuesOf({ ...OK, services: { 'stt-typo': { mode: 'always_on' } } })).toContain('services.stt-typo');
  });

  it('未知の運用モードを弾く', () => {
    expect(issuesOf({ ...OK, services: { stt: { mode: 'always-on' } } })).toContain('services.stt.mode');
  });

  it('temporaryOverride の state と expiresAt を検証する', () => {
    expect(issuesOf({ ...OK, services: { stt: { temporaryOverride: { state: 'stopped', expiresAt: '2026-07-22T12:00:00Z' } } } })).toContain(
      'services.stt.temporaryOverride.state',
    );
    // オフセットも秒も無い値は許す（ポリシー TZ で解釈する）。末尾に余計なものが付くのは不可。
    expect(issuesOf({ ...OK, services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-22T12:00oops' } } } })).toContain(
      'services.stt.temporaryOverride.expiresAt',
    );
    expect(
      validateRuntimePolicyInput({
        ...OK,
        services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: '2026-07-22T12:00' } } },
      }).ok,
    ).toBe(true);
  });

  /**
   * 🔴 **「弾いたか」だけでなく「何を返したか」を固定する。** 変異検証で、`services` を
   * 素通しにする／サービス個別の例外日を黙って `[]` に落とす、といった変異が**全部生き残った**
   * ——入力の形しか見ておらず、出力を誰も見ていなかった。例外日が消えれば、止めるつもりの日に
   * サービスが動き（AWS 費用）、動かすつもりの日に止まる（受付不能）。
   */
  it('検証済みのフィールドだけを組み立て直し、値は正規化済みのものを返す', () => {
    const result = validateRuntimePolicyInput({
      ...OK,
      services: {
        stt: {
          mode: 'custom_schedule',
          // 区間・例外日の内側の余計なキーは委譲先が落とす（PII を保存させない）。
          weeklySchedule: { mon: [{ start: '09:00', end: '18:00', memo: '来訪者メモ' }] },
          exceptionDates: [{ date: '2026-07-22', closed: true, memo: '来訪者メモ' }],
        },
      },
      breakGlass: { active: true, serviceKeys: ['stt'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(['breakGlass', 'commonSchedule', 'services']);
    expect(result.value.services).toEqual({
      stt: {
        mode: 'custom_schedule',
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
        exceptionDates: [{ date: '2026-07-22', closed: true }],
      },
    });
    expect(result.value.breakGlass).toEqual({ active: true, serviceKeys: ['stt'] });
  });

  /**
   * 🔴 **`null` の可否を階層で変えない。** 共通側は `weeklySchedule: null` を弾くのに、
   * サービス個別だけ `?? {}` で `{}` へ潰していた。`{}` は解決では「区間ゼロ = 恒久 stopped」
   * なので、運用画面の「個別設定をクリア」（フォーム系が素直に送るのは `null`）が
   * **realtime-conversation を営業時間内も永久停止**させ、しかも `reason` は
   * `custom_service_schedule` という正当に見える値で返る。運用者の意図（共通へ戻す）と真逆。
   */
  it('サービス個別スケジュールの null を共通側と同じく弾く（{} へ潰さない）', () => {
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: null } } })).toContain(
      'services.stt.weeklySchedule',
    );
    expect(issuesOf({ ...OK, services: { stt: { exceptionDates: null } } })).toContain(
      'services.stt.exceptionDates',
    );
    // 「共通営業時間へ戻す」はキーの省略で表す。こちらは通り、かつ何も保存しない。
    const cleared = validateRuntimePolicyInput({ ...OK, services: { stt: { mode: 'follow_operating_hours' } } });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.services?.stt).toEqual({ mode: 'follow_operating_hours' });
  });

  /**
   * 🔴 **未知キーを黙って捨てない**という規則が `services.<key>` の 1 階層にしか効いておらず、
   * その内側が素通しだった。`temporaryOveride`（1 文字 typo）で「停止しました」と表示されるのに
   * EC2 は動き続ける。`breakGlass.serviceKey`（単数形）はさらに悪く、`serviceKeys` 省略 =
   * 「保護対象以外を全停止」へ倒れるので、**1 サービスのつもりが iPad のタッチ受付も QR も全滅**する。
   */
  it('override / temporaryOverride / breakGlass の未知キーも issue にする', () => {
    expect(issuesOf({ ...OK, services: { stt: { temporaryOveride: { state: 'force_stopped' } } } })).toContain(
      'services.stt.temporaryOveride',
    );
    expect(issuesOf({ ...OK, services: { stt: { Mode: 'manual_only' } } })).toContain('services.stt.Mode');
    expect(issuesOf({ ...OK, services: { stt: { fixedHolidays: ['07-22'] } } })).toContain(
      'services.stt.fixedHolidays',
    );
    expect(
      issuesOf({
        ...OK,
        services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: '2099-01-01', reason: 'x' } } },
      }),
    ).toContain('services.stt.temporaryOverride.reason');
    expect(issuesOf({ ...OK, breakGlass: { active: true, serviceKey: 'stt' } })).toContain('breakGlass.serviceKey');
  });

  it('issue の field に入力キーを丸ごと載せない（長さと制御文字を落とす）', () => {
    // 構造化ログへ流れると偽イベント行を注入できる。レスポンス肥大も避ける。
    // U+2028 / U+2029 は `\p{C}` に**含まれない**（Zl/Zp）が、JS の LineTerminator であり
    // `JSON.stringify` もエスケープしない。行注入としては改行と同じ。
    const issues = issuesOf({ ...OK, services: { ['a\nb\rINJECTED level=fatal']: {}, ['c\u2028d\u2029e']: {} } });
    expect(issues.some((f) => /[\n\r\u2028\u2029]/.test(f))).toBe(false);
    const long = issuesOf({ ...OK, services: { ['x'.repeat(500)]: {} } });
    expect(long.every((f) => f.length <= 128)).toBe(true);
    // 先頭だけ残すと、同じ前置を持つ 2 つのキーが同じ `field` に潰れて特定できなくなる。
    const pair = issuesOf({ ...OK, services: { [`${'x'.repeat(200)}-alpha`]: {}, [`${'x'.repeat(200)}-beta`]: {} } });
    expect(new Set(pair).size).toBe(2);
  });

  it('サービス数・breakGlass の対象数に上限を持つ（issue の氾濫で応答を膨らませない）', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) many[`svc-${i}`] = {};
    expect(issuesOf({ ...OK, services: many }).length).toBeLessThanOrEqual(4);
    expect(issuesOf({ ...OK, services: many })).toContain('services');
    // 上限は**重複を畳んだ後**の数なので、相異なるキーで確かめる（同じ値の 200 件は 1 件）。
    const distinct = Array.from({ length: 200 }, (_, i) => `svc-${i}`);
    expect(issuesOf({ ...OK, breakGlass: { active: true, serviceKeys: distinct } })).toContain(
      'breakGlass.serviceKeys',
    );
  });

  it('空の weeklySchedule を「区間ゼロ = 恒久停止」として受け取らない', () => {
    /*
     * 🔴 `null` を塞いだだけでは足りない。行を全部消したフォームが素直に作る `{}` は、
     * 解決では「区間ゼロ = 恒久 stopped」になり、`mode` を `follow_operating_hours` へ戻しても
     * 段 4 が段 5 を上書きするので**共通営業時間へ戻らない**。運用者から見ると
     * 「共通に戻したのに音声受付が動かない」。共通へ戻すのはキーの省略。
     */
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: {} } } })).toContain(
      'services.stt.weeklySchedule',
    );
    expect(messagesOf({ ...OK, services: { stt: { weeklySchedule: {} } } }).join(' ')).toContain('omit');
  });

  it('breakGlass の対象は重複を畳んでから上限判定する', () => {
    // 上限 10 は distinct 前提。重複したまま数えると、実質 2 サービスの緊急停止が
    // 「too many entries」で 400 になる——不発の害が最も大きい経路で。
    const result = validateRuntimePolicyInput({
      ...OK,
      breakGlass: { active: true, serviceKeys: ['stt', 'stt', 'stt', 'admin', 'admin'] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.breakGlass?.serviceKeys).toEqual(['stt', 'admin']);
    const many = new Array(30).fill('stt');
    expect(validateRuntimePolicyInput({ ...OK, breakGlass: { active: true, serviceKeys: many } }).ok).toBe(true);
  });

  it('issue の総数を打ち切り、応答が入力に比例して膨らまないようにする', () => {
    // 「件数 ≤ N」ではなく**バイト数**で縛る（目的は応答肥大の阻止であって件数ではない）。
    const noisy: Record<string, unknown> = { ...OK };
    for (let i = 0; i < 50_000; i++) noisy[`bogus-${i}`] = 1;
    const result = validateRuntimePolicyInput(noisy);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error).length).toBeLessThan(8_000);

    // 階層ごとの上限だけでは総量を抑えられない（10 サービス × 未知キー、委譲先の例外日 366 件 …）。
    const perService: Record<string, unknown> = {};
    for (const key of MANAGED_RUNTIME_SERVICE_KEYS) {
      const override: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) override[`bogus-${i}`] = 1;
      perService[key] = override;
    }
    const spread = validateRuntimePolicyInput({ ...OK, services: perService });
    expect(spread.ok).toBe(false);
    if (spread.ok) return;
    expect(spread.error.issues.length).toBeLessThanOrEqual(51);
  });

  it('プロトタイプ由来のキーを既知キーと取り違えない', () => {
    // `key in known` に緩めると `toString` / `constructor` がすり抜ける。
    for (const key of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(issuesOf({ ...OK, [key]: 'x' }), key).toContain(`root.${key}`);
    }
  });

  it('未知キー・上限の文言を固定する', () => {
    expect(messagesOf({ ...OK, servcies: {} })).toContain('unknown field');
    expect(messagesOf({ ...OK, services: { nope: {} } })).toContain('unknown service key');
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) many[`svc-${i}`] = {};
    expect(messagesOf({ ...OK, services: many }).join(' ')).toContain('too many entries');
  });

  it('永続層の管理フィールドを body から混ぜられない（mass-assignment）', () => {
    // 採用しないだけでなく**拒否する**。黙って捨てると、送った側は効いたと思い込む。
    expect(issuesOf({ ...OK, version: 99 })).toContain('root.version');
    expect(issuesOf({ ...OK, updatedBy: 'attacker' })).toContain('root.updatedBy');
    expect(issuesOf({ ...OK, services: { stt: { tenantId: 'other-tenant' } } })).toContain('services.stt.tenantId');
    expect(issuesOf({ ...OK, breakGlass: { active: true, activatedBy: 'attacker' } })).toContain(
      'breakGlass.activatedBy',
    );
    // 打ち間違いも同じ経路で拾う（`servcies` は「設定したのに効かない」として現れる）。
    expect(issuesOf({ ...OK, servcies: {} })).toContain('root.servcies');
  });

  it('未知キーの報告件数にも上限を持つ（1 オブジェクトで応答を膨らませない）', () => {
    // `services` のキー数だけ抑えても、**その内側**が無制限なら同じ応答肥大が残る。
    const noisy: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) noisy[`bogus-${i}`] = 1;
    const issues = issuesOf({ ...OK, services: { stt: noisy } });
    expect(issues.length).toBeLessThanOrEqual(6);
    expect(issues).toContain('services.stt');
  });

  it('services とサービス個別 override の形を弾く（黙って捨てない）', () => {
    // 黙って捨てると「設定したのに効かない」として現れ、画面上は成功に見える。
    expect(issuesOf({ ...OK, services: [] })).toContain('services');
    expect(issuesOf({ ...OK, services: 'x' })).toContain('services');
    expect(issuesOf({ ...OK, services: { stt: 'x' } })).toContain('services.stt');
    expect(issuesOf({ ...OK, services: { stt: { temporaryOverride: 'x' } } })).toContain(
      'services.stt.temporaryOverride',
    );
  });

  it('breakGlass の serviceKeys に未知のキーを許さない', () => {
    expect(issuesOf({ ...OK, breakGlass: { active: true, serviceKeys: ['stt', 'nope'] } })).toContain(
      'breakGlass.serviceKeys[1]',
    );
    expect(issuesOf({ ...OK, breakGlass: { active: 'yes' } })).toContain('breakGlass.active');
    expect(issuesOf({ ...OK, breakGlass: { active: true, serviceKeys: 'stt' } })).toContain('breakGlass.serviceKeys');
  });

  it('サービス個別スケジュールの時刻の形と逆転を弾く', () => {
    // 区間単位で報告するのは共通 validator の契約。ここで粒度を変えると委譲の意味が消える。
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: { mon: [{ start: '25:00', end: '26:00' }] } } } })).toContain(
      'services.stt.weeklySchedule.mon[0]',
    );
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: { mon: [{ start: '18:00', end: '09:00' }] } } } })).toContain(
      'services.stt.weeklySchedule.mon[0]',
    );
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: { moon: [] } } } })).toContain(
      'services.stt.weeklySchedule.moon',
    );
  });

  /**
   * 🔴 **この検証層の存在理由そのもの。**
   *
   * 最初に書いたこのテストは 4 入力すべてが完全形の fixture を spread しており、
   * **反例を 1 つも踏んでいなかった**（独立レビューが 44 個の反例を実測）。
   * 素通しになりやすい形（欠落・型違い・ネストの奥）を名指しで並べる。
   */
  it('検証を通った値は必ず解決できる（throw しない）', () => {
    const candidates: unknown[] = [
      OK,
      { ...OK, breakGlass: { active: true } },
      { ...OK, services: { stt: { mode: 'manual_only' }, bedrock: { weeklySchedule: {} } } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, timezone: '' } },
      // ここから下がレビューの反例。validate を通ったら resolve も通らねばならない。
      { commonSchedule: { timezone: 'Asia/Tokyo' } },
      { commonSchedule: { timezone: 'Asia/Tokyo', weeklySchedule: {} } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, fixedHolidays: null } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, fixedHolidays: {} } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, exceptionDates: 'x' } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, exceptionDates: [null] } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, weeklySchedule: { mon: 'x' } } },
      { ...OK, commonSchedule: { ...OK.commonSchedule, weeklySchedule: { mon: [null] } } },
      {
        ...OK,
        commonSchedule: {
          ...OK.commonSchedule,
          exceptionDates: [{ date: '2026-07-22', closed: false, ranges: 'x' }],
        },
      },
      { ...OK, services: { stt: { exceptionDates: 'x' } } },
      { ...OK, services: { stt: { exceptionDates: [null] } } },
      { ...OK, services: { stt: { exceptionDates: {} } } },
      { ...OK, services: [] },
      { ...OK, services: { stt: 'x' } },
      { ...OK, services: { stt: { weeklySchedule: { mon: [{ start: '09:00' }] } } } },
      { ...OK, services: { stt: { temporaryOverride: 'x' } } },
      { ...OK, breakGlass: { active: true, serviceKeys: 'stt' } },
    ];
    for (const raw of candidates) {
      const result = validateRuntimePolicyInput(raw);
      if (!result.ok) continue; // 弾いたなら解決へ到達しないので安全。
      expect(
        () => resolveServiceStates({ policy: result.value, now: NOW }),
        `validate を通ったのに解決が落ちる: ${JSON.stringify(raw)}`,
      ).not.toThrow();
    }
  });

  it('`new Date().toISOString()` の出力を受け付ける（延長の最も自然な実装を拒否しない）', () => {
    // ミリ秒つき ISO を弾くと、管理画面が `new Date(Date.now()+3600e3).toISOString()` で
    // 「1 時間延長」を計算する普通の実装で、延長が常に invalid_input になる。
    const expiresAt = new Date('2026-07-22T12:00:00.000Z').toISOString();
    expect(
      validateRuntimePolicyInput({ ...OK, services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt } } } }).ok,
    ).toBe(true);
  });

  it('保存する expiresAt は正規化済み（検証だけ trim して生値を保存しない）', () => {
    // 改行込みの値がそのまま DynamoDB → API 応答 → 画面 → 監査 metadata まで流れると、
    // `expiresAtMs` を通らない消費者（画面の `new Date()`、TTL 計算、ログ）が別の結果になる。
    const result = validateRuntimePolicyInput({
      ...OK,
      services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: ' 2099-01-01T00:00:00 ' } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.services?.stt?.temporaryOverride?.expiresAt).toBe('2099-01-01T00:00:00');
  });

  it('暦として存在しない日付を弾く（黙って別の時刻へ読み替えない）', () => {
    // `2026-13-01` は `Date` のロールオーバーで 2027-01-01 になる。`force_stopped` と
    // 組み合わせると、月の 1 桁ミスが**約 7 か月のサービス停止**になる。
    /*
     * `00xx` 年は `Date.UTC` が 19xx へ写す。resolve から見ると「ただの過去日時 = 自動解除」で
     * 区別が付かないので、**ここで弾いたことを固定する**——年の桁を落とした入力
     * （`0226-...`）が、画面上は「延長した」のに実際は無効、という形で消えるのを防ぐ。
     */
    for (const bad of ['2026-13-45', '2026-99-99', '2026-02-30', '0000-00-00', '0099-12-31', '2026-07-22T99:99', '2026-07-22T12:00:99']) {
      expect(
        issuesOf({ ...OK, services: { stt: { temporaryOverride: { state: 'force_stopped', expiresAt: bad } } } }),
        `expiresAt=${bad}`,
      ).toContain('services.stt.temporaryOverride.expiresAt');
    }
  });

  it('crossesMidnight は共通側と同じ契約（end < start を要求する）', () => {
    // 共通側は `crossesMidnight` のとき `end < start` を必須にする。runtime 側が緩いと
    // 「09:00-18:00」と書いたつもりの区間が持ち越しで**実質終日 open** になり、
    // realtime-conversation（EC2）が営業時間外も止まらない＝ AWS 費用が 24/7 で出る。
    expect(
      issuesOf({
        ...OK,
        services: { stt: { weeklySchedule: { mon: [{ start: '09:00', end: '18:00', crossesMidnight: true }] } } },
      }),
    ).not.toEqual([]);
  });

  it('件数の上限を共通側と揃える（保存不能・Reconciler の予算超過を作らない）', () => {
    const many = Array.from({ length: 3000 }, () => ({ start: '09:00', end: '10:00' }));
    expect(issuesOf({ ...OK, services: { stt: { weeklySchedule: { mon: many } } } })).not.toEqual([]);
  });
});
