/**
 * 型の壊れたセキュリティ設定（`ipAllowlist` / `emergencyStop` / `pinRequired`）を読んだら
 * **閉じる側へ倒し**、それを**観測できる**こと (#1172)。
 *
 * ## 守る不変条件（機構より先に書く）
 *
 * > **保存レコードのセキュリティ設定が型として読めないなら、その記録での振る舞いは、
 * > そのフィールドが取りうる正しい値のどれよりも開かない**（IP は全拒否・受付は停止・
 * > 受付端末は許可を求め、PIN による許可も通さない）。その状態は、運用者がそのフィールドを
 * > 設定し直すまで無関係な更新を経ても続き、監査と管理画面の両方から分かる。
 *
 * 倒す向きは owner 判断（2026-09-29。3 つとも fail closed）。
 *
 * - 上界: 何回読んでも監査は**プロセスにつき 1 本**（#1160 のラッチと同じ理由）
 * - 下界: 読める記録（**正しい形の空の許可リスト `[]` を含む**）では 1 本も出ず、`[]` は今までどおり
 *   制限なし（「全部を閉じる」実装で空虚に満たさない）
 * - 値を載せない: 監査に保存値を出さない。metadata のキーに `pin` / `credential` を含めない（#1173）
 * - 下界（閉じっぱなしにしない）: 運用者がそのフィールドを明示的に設定し直せば直る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPin, isUsablePinCredential } from '@/domain/security/pin';
import { isIpAllowed, type UnreadableSecurityField } from '@/domain/security/types';
import { getBackend } from '@/lib/data';

vi.mock('@/lib/data-stores/reception-log-store', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/data-stores/reception-log-store')>();
  return { ...actual, appendAuditLog: vi.fn(actual.appendAuditLog) };
});

import {
  __resetLogStore,
  appendAuditLog,
  listAuditLogs,
} from '@/lib/data-stores/reception-log-store';
import {
  __resetSecurity,
  getSecuritySettings,
  readSecuritySettings,
  revisionOf,
  updateSecuritySettings,
  verifyPin,
} from './security-store';

const ACTION = 'security.settings_unreadable';
const PIN_ACTION = 'security.pin_credential_unreadable';

/** 許可リストに載せる IP と、載せない IP。 */
const LISTED = '203.0.113.7';
const UNLISTED = '198.51.100.1';
/** 記録に入れる、読める PIN（平文の旧レコード形式）。 */
const PIN = '4821';

const store = () => getBackend().singleton<Record<string, unknown>>('security', { default: () => ({}) });

async function putRaw(record: Record<string, unknown>): Promise<void> {
  await store().put(record);
}

/** 読める記録。各テストはここから 1 フィールドずつ壊す。 */
function wellFormed(): Record<string, unknown> {
  return { pinRequired: false, pin: PIN, pinSetByOperator: true, ipAllowlist: [LISTED], emergencyStop: false };
}

async function entries() {
  return (await listAuditLogs()).filter((e) => e.action === ACTION);
}

async function currentRev(): Promise<number> {
  return revisionOf((await getSecuritySettings()).rev);
}

beforeEach(async () => {
  await __resetSecurity();
  await __resetLogStore();
  vi.mocked(appendAuditLog).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * 壊れ方の列挙は `unreadableFieldsOf` の判定（配列か・boolean か）から導いた。
 * 🔴 **truthy な綴りと falsy な綴りを両方置く。** 以前の実装は truthy で読んでいたので、
 *    片側だけだと「truthy で読む」へ戻す変異の半分が生存する（`'true'` の緊急停止は元から停止）。
 */
const BROKEN_IP: ReadonlyArray<readonly [string, unknown]> = [
  ['文字列（#1172 の再現例）', LISTED],
  ['オブジェクト', { a: 1 }],
  ['null', null],
  ['欠落', undefined],
  ['数値', 0],
];
const BROKEN_BOOL: ReadonlyArray<readonly [string, unknown]> = [
  ['欠落', undefined],
  ["文字列 'false'", 'false'],
  ["文字列 'true'", 'true'],
  ['0', 0],
  ['1', 1],
  ['null', null],
];

describe('型の壊れたセキュリティ設定は fail closed で、観測できる (#1172)', () => {
  it.each(BROKEN_IP)('🔴 AC1 ipAllowlist が %s: どの IP も許可しない（載っていた IP も）', async (_l, value) => {
    await putRaw({ ...wellFormed(), ipAllowlist: value });
    const s = await getSecuritySettings();
    expect(s.ipAllowlist).toBeNull();
    for (const ip of [LISTED, UNLISTED, '']) expect(isIpAllowed(ip, s.ipAllowlist), ip).toBe(false);
    expect(s.unreadableFields).toEqual(['ipAllowlist']);
    // 隣のフィールドは読めた値のまま（巻き添えで倒していない）。
    expect(s).toMatchObject({ emergencyStop: false, pinRequired: false });
  });

  it.each(BROKEN_BOOL)('🔴 AC2 emergencyStop が %s: 停止として読む', async (_l, value) => {
    await putRaw({ ...wellFormed(), emergencyStop: value });
    const s = await getSecuritySettings();
    expect(s.emergencyStop).toBe(true);
    expect(s.unreadableFields).toEqual(['emergencyStop']);
    expect(s.ipAllowlist).toEqual([LISTED]);
  });

  /**
   * 🔴 AC3: PIN 必須として読む（受付端末は許可を求める）。**照合は通さない** —— `pinRequired: false` の
   * サイトでは PIN による自己許可そのものが無効なので、壊れた記録を「必須」と読んで正しい PIN を
   * 通すと、そのサイトで閉じていた経路が開く（取りうる正しい値のどれよりも開かない、の側）。
   */
  it.each(BROKEN_BOOL)('🔴 AC3 pinRequired が %s: PIN 必須として読み、どの PIN でも照合を通さない', async (_l, value) => {
    await putRaw({ ...wellFormed(), pinRequired: value });
    const s = await getSecuritySettings();
    expect(s.pinRequired).toBe(true);
    expect(s.unreadableFields).toEqual(['pinRequired']);
    for (const probe of [PIN, '0000', '', String(value)]) expect(await verifyPin(probe), probe).toBe(false);
  });

  it('🔴 AC4 監査は 1 本で、どのフィールドかと効果だけを残し、値を残さない', async () => {
    await putRaw({ pinRequired: 'false', pin: PIN, ipAllowlist: 'SECRET-LOOKING-203.0.113.99', emergencyStop: 'nope' });
    const s = await getSecuritySettings();
    const fields: UnreadableSecurityField[] = ['ipAllowlist', 'emergencyStop', 'pinRequired'];
    expect(s.unreadableFields).toEqual(fields);
    const [entry, ...rest] = await entries();
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ actor: 'system', targetType: 'security' });
    expect(entry?.metadata).toEqual({ reason: 'stored_record_unreadable', fields: fields.join(','), effect: 'fail_closed' });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('SECRET-LOOKING');
    expect(serialized).not.toContain('nope');
    // #1173: metadata のキーに pin / credential を含めない（sanitize で潰されない経路なので）。
    for (const key of Object.keys(entry?.metadata ?? {})) expect(key).not.toMatch(/pin|credential/i);
  });

  /** 🔴 **上界。** 未認証の経路（authorize / session-status / heartbeat）は毎回読む。何度読んでも 1 本。 */
  it('🔴 AC4 何度読んでも監査はプロセスにつき 1 本', async () => {
    await putRaw({ ...wellFormed(), ipAllowlist: null, emergencyStop: undefined });
    for (let i = 0; i < 25; i += 1) {
      await getSecuritySettings();
      await verifyPin(String(i).padStart(4, '0'));
    }
    await readSecuritySettings();
    expect(await entries()).toHaveLength(1);
    expect(vi.mocked(appendAuditLog).mock.calls.filter((c) => c[0].action === ACTION)).toHaveLength(1);
  });

  it('🔴 AC4 監査の書き込みが失敗しても閉じたままで、再試行で増幅しない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error('audit down'));
    await putRaw({ ...wellFormed(), ipAllowlist: LISTED });
    for (let i = 0; i < 5; i += 1) expect((await getSecuritySettings()).ipAllowlist).toBeNull();
    expect(vi.mocked(appendAuditLog).mock.calls.filter((c) => c[0].action === ACTION)).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(LISTED);
    // 監査が落ちても、画面側は読めないと答える。
    expect((await readSecuritySettings()).settings.unreadableFields).toEqual(['ipAllowlist']);
  });

  /**
   * #1172 L1: 読めない PIN の監査の `lockout` は、照合と同じ正規化後の `pinRequired` で決める
   * （以前は `=== true` で決めていたので、`'true'` の記録で照合は締め出すのに監査は false と言った）。
   */
  it('読めない PIN の監査の lockout は、正規化後の PIN 必須と一致する', async () => {
    await putRaw({ ...wellFormed(), pin: '', pinRequired: 'true' });
    expect(await verifyPin('')).toBe(false);
    const [pinEntry] = (await listAuditLogs()).filter((e) => e.action === PIN_ACTION);
    expect(pinEntry?.metadata).toMatchObject({ lockout: 'true' });
  });
});

describe('下界: 読める記録では倒さず、監査も出さない (#1172 AC5)', () => {
  it.each([
    ['レコード無し（既定）', async () => {}],
    ['KIOSK_PIN を入れている', async () => {
      vi.stubEnv('KIOSK_PIN', PIN);
      await __resetSecurity();
    }],
    ['正しい形の空の許可リスト', async () => putRaw({ ...wellFormed(), ipAllowlist: [] })],
    ['許可リストあり・停止中・PIN 必須', async () =>
      putRaw({ ...wellFormed(), ipAllowlist: [LISTED], emergencyStop: true, pinRequired: true })],
    ['ハッシュ記録', async () => putRaw({ ...wellFormed(), pin: await hashPin(PIN) })],
    ['管理 API で保存した記録', async () =>
      void (await updateSecuritySettings({ rev: await currentRev(), pinRequired: true, ipAllowlist: [], pin: PIN }))],
  ])('🔴 %s', async (_l, arrange) => {
    await arrange();
    await getSecuritySettings();
    await verifyPin(PIN);
    await updateSecuritySettings({ emergencyStop: false });
    expect(await entries()).toHaveLength(0);
    expect((await readSecuritySettings()).settings.unreadableFields).toEqual([]);
  });

  /** 🔴 **`[]` の意味（制限なし）は変えていない。** 壊れた記録と区別できていること。 */
  it('🔴 正しい形の空の許可リストは、どの IP も許可する', async () => {
    await putRaw({ ...wellFormed(), ipAllowlist: [] });
    const s = await getSecuritySettings();
    expect(s.ipAllowlist).toEqual([]);
    for (const ip of [LISTED, UNLISTED]) expect(isIpAllowed(ip, s.ipAllowlist)).toBe(true);
  });

  it('読める boolean はそのまま（false を閉じる側へ倒していない）', async () => {
    await putRaw({ ...wellFormed(), pinRequired: false, emergencyStop: false });
    const s = await getSecuritySettings();
    expect(s).toMatchObject({ pinRequired: false, emergencyStop: false });
    // PIN 必須でなければ照合は通る（#244 の route が 403 で塞ぐ。照合の意味は変えていない）。
    expect(await verifyPin('anything')).toBe(true);
  });

  it('PIN 必須の読める記録では、正しい PIN だけが通る', async () => {
    await putRaw({ ...wellFormed(), pinRequired: true });
    expect(await verifyPin(PIN)).toBe(true);
    expect(await verifyPin('0000')).toBe(false);
  });
});

describe('無関係な更新で直らず、明示的な設定で直る (#1172)', () => {
  const ALL_BROKEN = { pinRequired: 'false', pin: PIN, pinSetByOperator: true, ipAllowlist: LISTED, emergencyStop: undefined };

  /**
   * 🔴 **無関係な更新で開く側へ化けない。** 解釈（`null`）は書けないので、解釈のまま書き戻すと
   * `[]`（制限なし）に化けうる。緊急停止のトグルや PIN の変更を経ても、送っていないフィールドは
   * 読めないまま閉じる側に残り、観測も続く。
   */
  it('🔴 緊急停止の投入だけでは、IP 許可リストと PIN 必須は直らない', async () => {
    await putRaw(ALL_BROKEN);
    const updated = await updateSecuritySettings({ emergencyStop: true });
    // 応答も閉じる側（`pinRequired: undefined` や `ipAllowlist: []` を返さない）。
    expect(updated).toMatchObject({ ipAllowlist: null, pinRequired: true, emergencyStop: true });
    expect(updated.unreadableFields).toEqual(['ipAllowlist', 'pinRequired']);
    const s = await getSecuritySettings();
    expect(s.ipAllowlist).toBeNull();
    expect(isIpAllowed(UNLISTED, s.ipAllowlist)).toBe(false);
    expect(s.unreadableFields).toEqual(['ipAllowlist', 'pinRequired']);
    expect(await verifyPin(PIN)).toBe(false);
    // 記録は生のまま（正しい形に化けていない）。
    const raw = await store().get();
    expect(Array.isArray(raw?.ipAllowlist)).toBe(false);
    expect(typeof raw?.pinRequired).not.toBe('boolean');
    // 無関係な更新自体は効いている（何も書かずに返しているなら上の主張は空虚）。
    expect(raw?.emergencyStop).toBe(true);
  });

  it('🔴 PIN だけの保存でも、IP 許可リスト・緊急停止・PIN 必須は直らない', async () => {
    await putRaw(ALL_BROKEN);
    const updated = await updateSecuritySettings({ rev: await currentRev(), pin: '5839' });
    expect(updated).toMatchObject({ ipAllowlist: null, pinRequired: true, emergencyStop: true });
    expect(updated.unreadableFields).toEqual(['ipAllowlist', 'emergencyStop', 'pinRequired']);
    const raw = await store().get();
    expect(Array.isArray(raw?.ipAllowlist)).toBe(false);
    expect(isUsablePinCredential(raw?.pin as string)).toBe(true);
    expect(await verifyPin('5839')).toBe(false);
  });

  /** 下界（閉じっぱなしにしない）: 運用者がそのフィールドを明示的に書けば直り、観測も消える。 */
  it('🔴 管理画面の保存（PIN 必須と許可リストを明示）と緊急停止の解除で全部直る', async () => {
    await putRaw(ALL_BROKEN);
    const saved = await updateSecuritySettings({ rev: await currentRev(), pinRequired: true, ipAllowlist: [LISTED] });
    expect(saved.unreadableFields).toEqual(['emergencyStop']);
    expect(saved.ipAllowlist).toEqual([LISTED]);
    const resumed = await updateSecuritySettings({ emergencyStop: false });
    expect(resumed.unreadableFields).toEqual([]);
    const s = await getSecuritySettings();
    expect(s).toMatchObject({ pinRequired: true, emergencyStop: false, ipAllowlist: [LISTED] });
    expect(isIpAllowed(LISTED, s.ipAllowlist)).toBe(true);
    expect(isIpAllowed(UNLISTED, s.ipAllowlist)).toBe(false);
    expect(await verifyPin(PIN)).toBe(true);
  });

  it('🔴 空の許可リストを明示して保存すれば制限なしへ戻る（運用者の明示的な判断）', async () => {
    await putRaw({ ...wellFormed(), ipAllowlist: LISTED });
    const saved = await updateSecuritySettings({ rev: await currentRev(), ipAllowlist: [] });
    expect(saved.ipAllowlist).toEqual([]);
    expect(isIpAllowed(UNLISTED, (await getSecuritySettings()).ipAllowlist)).toBe(true);
  });
});
