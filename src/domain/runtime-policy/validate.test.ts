import { describe, expect, it } from 'vitest';
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
      // 永続層の管理フィールドを body から混ぜられても採用しない（mass-assignment）。
      version: 99,
      updatedBy: 'attacker',
      services: {
        stt: {
          mode: 'custom_schedule',
          weeklySchedule: { mon: [{ start: '09:00', end: '18:00', memo: '来訪者メモ' }] },
          exceptionDates: [{ date: '2026-07-22', closed: true, memo: '来訪者メモ' }],
          tenantId: 'other-tenant',
        },
      },
      breakGlass: { active: true, serviceKeys: ['stt'], activatedBy: 'attacker' },
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
