/**
 * 壊れた PIN 記録が組込み既定へ倒れたことを**観測できる**こと (#1160)。
 *
 * ## 守る不変条件（機構より先に書く）
 *
 * > **保存レコードの PIN を資格情報として読めず、組込み既定で代用したなら、
 * > それは監査と管理画面の両方から分かる。代用後の挙動は変えない。**
 *
 * - 上界: 未認証の `authorize` が何回叩いても、監査は**プロセスにつき 1 本**しか増えない
 *   （監査の書き込み量を外部から制御させない。#1123 のラッチと同じ理由）
 * - 下界: 読める記録（平文の旧レコード・ハッシュ・レコード無し・`KIOSK_PIN`）では
 *   **1 本も出ない**（誤報を出す実装でも「1 本出る」は満たせるので、両側を縛る）
 * - 値を載せない: 監査にも応答にも、保存されていた文字列を出さない
 *   （`rules/pii-secret-minimization.md`）
 *
 * 🔴 **倒す先（既定値 or 誰も通さない）は変えない。** それは #1160 AC3 = PIN 制御の境界変更で、
 * 人間承認が要る。ここで足すのは**観測**だけである。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULT_PIN, hashPin, isPinConfigured } from '@/domain/security/pin';
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
  updateSecuritySettings,
  verifyPin,
} from './security-store';

const ACTION = 'security.pin_credential_defaulted';

async function putRaw(record: Record<string, unknown>): Promise<void> {
  await getBackend().singleton('security', { default: () => ({}) }).put(record);
}

async function fallbackEntries() {
  return (await listAuditLogs()).filter((e) => e.action === ACTION);
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
 * `current()` が組込み既定で代用する綴りを**`isUsablePinCredential` の分岐から**列挙した:
 * 空・非文字列（欠落を含む）・`classify` の 2 段目で落ちるもの（反復回数・salt）。
 */
const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
  ['salt が復号できない（#1160 の再現例）', 'pbkdf2-sha256$10000$***$BBBB'],
  ['反復回数が上限超え', 'pbkdf2-sha256$2000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
  ['反復回数が 0', 'pbkdf2-sha256$0$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
  ['空文字', ''],
  ['pin 属性の欠落', undefined],
  ['文字列でない', 4821],
];

describe('読めない PIN 記録の観測 (#1160 AC1 / AC4)', () => {
  it.each(UNREADABLE)('🔴 %s: 監査に 1 本残り、既定値の挙動は変わらない', async (_label, pin) => {
    await putRaw({
      pinRequired: true,
      pin,
      pinSetByOperator: true,
      ipAllowlist: [],
      emergencyStop: false,
    });

    // 挙動は変えていない（AC3 は人間承認待ち）: 既定値で通り、記録の文字列では通らない。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
    if (typeof pin === 'string' && pin !== '') expect(await verifyPin(pin)).toBe(false);

    const entries = await fallbackEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetType).toBe('security');
    // 🔴 値を載せない: 保存されていた文字列もその断片も、監査の行に出ない。
    const serialized = JSON.stringify(entries[0]);
    if (typeof pin === 'string' && pin !== '') {
      for (const part of pin.split('$').filter((p) => p.length >= 3)) {
        expect(serialized).not.toContain(part);
      }
    }
    if (typeof pin === 'number') expect(serialized).not.toContain(String(pin));

    // 管理画面向けの読み出しも同じ事実を答える（AC2 の配線元）。
    const read = await readSecuritySettings();
    expect(read.storedPinUnreadable).toBe(true);
    // 読めない資格情報を「設定済み」とは言わない（既存の約束を崩していない）。
    expect(isPinConfigured(read.settings)).toBe(false);
  });

  /**
   * 🔴 **上界。** 未認証の `authorize` は `verifyPin` を毎回呼ぶので、監査を読み出しごとに
   * 書くと**外部から監査の書き込み量を制御できる**。何度読んでも 1 本。
   */
  it('🔴 何度読んでも監査はプロセスにつき 1 本', async () => {
    await putRaw({ pinRequired: true, pin: '', ipAllowlist: [], emergencyStop: false });
    for (let i = 0; i < 25; i += 1) await verifyPin(String(i).padStart(4, '0'));
    await getSecuritySettings();
    await readSecuritySettings();
    expect(await fallbackEntries()).toHaveLength(1);
    expect(vi.mocked(appendAuditLog).mock.calls.filter((c) => c[0].action === ACTION)).toHaveLength(1);
  });

  /**
   * 🔴 **無関係な更新で記録が上書きされる経路でも残る。** #1160 本文のとおり、次の更新で
   * `hash('0000')` が書かれ元の記録は恒久的に失われる。**上書きの前に**監査が出ていること。
   */
  it('🔴 読み出しを経ずに更新しても、上書きの前に監査が残る', async () => {
    await putRaw({
      pinRequired: true,
      pin: 'pbkdf2-sha256$10000$***$BBBB',
      pinSetByOperator: true,
      ipAllowlist: [],
      emergencyStop: false,
    });
    await updateSecuritySettings({ emergencyStop: true });
    expect(await fallbackEntries()).toHaveLength(1);
    // 更新後は読める記録になっている（既定値のハッシュ）ので、以降は「読めない」と言わない。
    expect((await readSecuritySettings()).storedPinUnreadable).toBe(false);
  });

  /**
   * 🔴 **下界（誤報を出さない）。** 「1 本出る」だけなら、毎回出す実装でも満たせる。
   * 読める記録では 1 本も出ず、画面にも出ない。
   */
  it.each([
    ['レコード無し（既定）', async () => {}],
    ['KIOSK_PIN を入れている', async () => {
      vi.stubEnv('KIOSK_PIN', '4821');
      await __resetSecurity();
    }],
    ['平文の旧レコード', async () => {
      await putRaw({ pinRequired: true, pin: '4821', ipAllowlist: [], emergencyStop: false });
    }],
    ['組込み既定の平文の旧レコード', async () => {
      await putRaw({ pinRequired: true, pin: BUILTIN_DEFAULT_PIN, ipAllowlist: [], emergencyStop: false });
    }],
    ['ハッシュ記録', async () => {
      await putRaw({
        pinRequired: true,
        pin: await hashPin('4821'),
        pinSetByOperator: true,
        ipAllowlist: [],
        emergencyStop: false,
      });
    }],
    ['管理 API で保存した記録', async () => {
      await updateSecuritySettings({ pinRequired: true, pin: '4821' });
    }],
  ])('🔴 読める記録では監査も表示も出ない: %s', async (_label, arrange) => {
    await arrange();
    await verifyPin('4821');
    await verifyPin(BUILTIN_DEFAULT_PIN);
    await updateSecuritySettings({ emergencyStop: false });
    expect(await fallbackEntries()).toHaveLength(0);
    expect((await readSecuritySettings()).storedPinUnreadable).toBe(false);
  });

  /**
   * 🔴 **監査の失敗で authorize を落とさない。** 観測を足しただけで挙動を変えない（AC4）。
   * 監査ストアが落ちているとき、未認証の要求ごとに書き込みを再試行させない（上界と同じ理由）。
   */
  it('🔴 監査の書き込みが失敗しても照合は今日と同じ答えを返し、再試行で増幅しない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unusable = 'pbkdf2-sha256$10000$***$BBBB';
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error('audit down'));
    await putRaw({ pinRequired: true, pin: unusable, ipAllowlist: [], emergencyStop: false });

    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
    expect(await verifyPin(unusable)).toBe(false);
    for (let i = 0; i < 5; i += 1) await verifyPin('1111');

    expect(vi.mocked(appendAuditLog).mock.calls.filter((c) => c[0].action === ACTION)).toHaveLength(1);
    // 握ったことはサーバログに出る。値は出さない。
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('***$BBBB');
    // 失敗してもなお、画面側は「読めない」と答える（監査が落ちても運用者は気づける）。
    expect((await readSecuritySettings()).storedPinUnreadable).toBe(true);
  });
});
