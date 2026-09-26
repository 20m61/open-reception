/**
 * 壊れた PIN 記録を読んだら **fail closed**（誰も通さない）にし、それを**観測できる**こと (#1160)。
 *
 * ## 守る不変条件（機構より先に書く）
 *
 * > **保存レコードの PIN を資格情報として読めないなら、どの入力でも PIN 認可は通らない
 * > （公開既定値 `0000` にも、記録文字列にも化けない）。その状態は、運用者が PIN を
 * > 設定し直すまで無関係な更新を経ても続き、監査と管理画面の両方から分かる。**
 *
 * 🔴 **「読めない」は `classify` が `unusable` と判定するもの（と空・非文字列）に限る。**
 * 構造の段で落ちる崩れた hash（例 `pbkdf2-sha256$-1$…`・hash 部が空）は main の時点から
 * **平文として照合され、記録文字列そのものが PIN として通る**（PIN を送らない更新 1 回で
 * `hash(記録文字列)` に固定される）。この不変条件はそれを主張しない（別 Issue で扱う）。
 *
 * 倒す向きはユーザー判断（#1160 AC3・2026-09-26）: セキュリティ境界で既定の資格情報へ倒さない。
 *
 * - 上界: 未認証の `authorize` が何回叩いても、監査は**プロセスにつき 1 本**しか増えない
 *   （監査の書き込み量を要求数に比例させない。#1123 のラッチと同じ理由）。
 *   🔴 縛れるのは**プロセス内**だけで、Lambda では実行環境の数まで増える（store の doc）
 * - 下界: 読める記録（平文の旧レコード・ハッシュ・レコード無し・`KIOSK_PIN`）では
 *   **1 本も出ない**（誤報を出す実装でも「1 本出る」は満たせるので、両側を縛る）
 * - 値を載せない: 監査にも応答にも、保存されていた文字列を出さない
 *   （`rules/pii-secret-minimization.md`）
 * - 下界（締め出しっぱなしにしない）: 運用者が管理画面から PIN を設定し直せば、その PIN で通り、
 *   以降は「読めない」と言わない（復旧手順が既存の経路で完結する）
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

const ACTION = 'security.pin_credential_unreadable';

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
 * `current()` が拒否側へ倒す綴りを**`isUsablePinCredential` の分岐から**列挙した:
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

/** 総当たりの代表: 公開既定値・よくある PIN・空・記録文字列（呼び出し側で足す）。 */
const PROBES = [BUILTIN_DEFAULT_PIN, '1234', '4821', '0', ''] as const;

describe('読めない PIN 記録は fail closed で、観測できる (#1160)', () => {
  it.each(UNREADABLE)('🔴 %s: どの入力でも通らず、監査に 1 本残る', async (_label, pin) => {
    await putRaw({
      pinRequired: true,
      pin,
      pinSetByOperator: true,
      ipAllowlist: [],
      emergencyStop: false,
    });

    // 🔴 fail closed: 公開既定値でも、記録文字列でも、何を入れても通らない。
    for (const probe of [...PROBES, ...(typeof pin === 'string' ? [pin] : [String(pin)])]) {
      expect(await verifyPin(probe), `probe=${probe}`).toBe(false);
    }

    const entries = await fallbackEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetType).toBe('security');
    // 締め出しが実際に起きていること（PIN 必須）が監査から分かる。
    expect(entries[0]?.metadata).toMatchObject({ effect: 'deny_all', lockout: 'true' });
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
   * 🔴 **PIN を送らない更新で、拒否状態が解けない（既定値に化けない）。**
   * 以前は次の無関係な更新で `hash('0000')` が書かれ、元の記録は失われて `0000` で通った。
   * 緊急停止のトグルのような更新を経ても、記録は生のまま残り、拒否と観測が続く。
   */
  it.each(UNREADABLE)('🔴 %s: PIN を送らない更新を経ても通らず、読めないままと答える', async (_label, pin) => {
    await putRaw({ pinRequired: true, pin, pinSetByOperator: true, ipAllowlist: [], emergencyStop: false });
    await updateSecuritySettings({ emergencyStop: true });
    await updateSecuritySettings({ ipAllowlist: ['203.0.113.1'] });
    for (const probe of [...PROBES, ...(typeof pin === 'string' ? [pin] : [String(pin)])]) {
      expect(await verifyPin(probe), `probe=${probe}`).toBe(false);
    }
    const read = await readSecuritySettings();
    expect(read.storedPinUnreadable).toBe(true);
    // 無関係な更新自体は効いている（何も書かずに返しているなら上の主張は空虚）。
    expect(read.settings).toMatchObject({ emergencyStop: true, ipAllowlist: ['203.0.113.1'] });
    expect(await fallbackEntries()).toHaveLength(1);
  });

  /**
   * 🔴 **復旧手順（下界）。** 運用者が管理画面から PIN を設定し直せば、その PIN で通り、
   * 既定値では通らず、以降は「読めない」と言わない。締め出しっぱなしにならないこと。
   */
  it.each(UNREADABLE)('🔴 %s: 運用者が PIN を設定し直せば、その PIN でだけ通る', async (_label, pin) => {
    await putRaw({ pinRequired: true, pin, ipAllowlist: [], emergencyStop: false });
    await updateSecuritySettings({ pin: '5839' });
    expect(await verifyPin('5839')).toBe(true);
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    const read = await readSecuritySettings();
    expect(read.storedPinUnreadable).toBe(false);
    expect(isPinConfigured(read.settings)).toBe(true);
  });

  /** PIN 必須でないときは、読めない記録があっても端末は締め出されない（監査もそう言う）。 */
  it('PIN 必須でなければ締め出しは起きず、監査の lockout は false', async () => {
    await putRaw({ pinRequired: false, pin: '', ipAllowlist: [], emergencyStop: false });
    expect(await verifyPin('')).toBe(true);
    const [entry] = await fallbackEntries();
    expect(entry?.metadata).toMatchObject({ effect: 'deny_all', lockout: 'false' });
    expect((await readSecuritySettings()).storedPinUnreadable).toBe(true);
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
   * 🔴 **監査の失敗で照合の答えを変えない**（拒否のまま。throw して 500 にもしない）。
   * 監査ストアが落ちているとき、未認証の要求ごとに書き込みを再試行させない（上界と同じ理由）。
   */
  it('🔴 監査の書き込みが失敗しても照合は拒否のままで、再試行で増幅しない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unusable = 'pbkdf2-sha256$10000$***$BBBB';
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error('audit down'));
    await putRaw({ pinRequired: true, pin: unusable, ipAllowlist: [], emergencyStop: false });

    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
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
