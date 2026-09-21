import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULT_PIN, isHashedPin, isPinConfigured } from '@/domain/security/pin';
import { getBackend } from '@/lib/data';
import { __resetSecurity, getSecuritySettings, updateSecuritySettings, verifyPin } from './security-store';

beforeEach(async () => {
  await __resetSecurity();
});

describe('security-store (#23 #29)', () => {
  it('既定では PIN 不要', async () => {
    expect((await getSecuritySettings()).pinRequired).toBe(false);
  });

  it('PIN 不要なら任意の入力で許可', async () => {
    expect(await verifyPin('')).toBe(true);
  });

  it('PIN 必須に変更し、一致のみ許可する', async () => {
    await updateSecuritySettings({ pinRequired: true, pin: '1234' });
    expect(await verifyPin('1234')).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /**
   * 🔴 **保存されるのはハッシュで、平文は残らない (#1021 AC3)。**
   *
   * 設定ストアのダンプ・バックアップ・永続層の中身に PIN の平文が出ない、が目的。
   * （4 桁なのでハッシュが漏れれば総当たりできる。総当たり対策は AC4 の仕事で、
   * ここで達成しているのは「平文で置かない」ことだけ。）
   */
  it('🔴 保存した PIN は平文で残らない', async () => {
    const updated = await updateSecuritySettings({ pinRequired: true, pin: '4821' });
    expect(updated.pin).not.toContain('4821');
    expect(isHashedPin(updated.pin)).toBe(true);
    // 下界: 読み出しても平文に戻っていない（返り値だけを加工していない）。
    expect((await getSecuritySettings()).pin).not.toContain('4821');
    // 下界: それでも本人は通る（ハッシュにして終わり、ではない）。
    expect(await verifyPin('4821')).toBe(true);
  });

  /**
   * 🔴 **旧レコード（平文）を読めなくしない（読み互換）。**
   *
   * 既存の設定ストアには平文 PIN が入っている。読めなくすると
   * `pinRequired: true` のサイトが**誰も authorize できなくなる** ——
   * しかも管理画面からは直せない（PIN を変えるには authorize が要らないが、
   * 端末は止まる）。**ストアへ直接置いて**実行時に確かめる。
   */
  it('🔴 平文のまま保存されている旧レコードでも照合できる', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: '4821',
      ipAllowlist: [],
      emergencyStop: false,
    });
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /**
   * 🔴 **`pinConfigured` は「運用者が決めたか」を答える (#1021 MAJOR-8)。**
   * 以前は `pin !== ''` で、既定値が `'0000'` で入るため**常に true** だった。
   */
  it('🔴 既定のままなら未設定、決めたら設定済み', async () => {
    expect(isPinConfigured((await getSecuritySettings()).pin)).toBe(false);
    const updated = await updateSecuritySettings({ pin: '4821' });
    expect(isPinConfigured(updated.pin)).toBe(true);
  });

  /**
   * 🔴 **今日の振る舞いを保存する（#1021 AC3 は fail closed にしない）。**
   *
   * 既定 PIN を拒否するのは **PIN 制御の境界変更**なので、この増分ではやらない
   * （ユーザー判断で「読み互換＋ハッシュ書き」を選んだ）。既定のまま `pinRequired` を
   * 立てたサイトが**今日と同じように**通ることを固定する ——
   * ここが無いと、既定を空にする変異が「PIN が強くなった」ように見えて通ってしまう。
   */
  it('🔴 既定のままでも組込み既定の PIN で通る（振る舞いを変えていない）', async () => {
    await updateSecuritySettings({ pinRequired: true });
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /** 🔴 `KIOSK_PIN` を入れた運用者は「設定済み」と読まれる（既定と区別する）。 */
  it('🔴 KIOSK_PIN を入れていれば設定済みとして扱う', async () => {
    vi.stubEnv('KIOSK_PIN', '4821');
    await __resetSecurity();
    const settings = await getSecuritySettings();
    expect(isPinConfigured(settings.pin)).toBe(true);
    await updateSecuritySettings({ pinRequired: true });
    expect(await verifyPin('4821')).toBe(true);
    // 下界: 組込み既定では通らない（env を読んでいることの確認）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('IP 許可リストを更新できる', async () => {
    const updated = await updateSecuritySettings({ ipAllowlist: ['10.0.0.1', ' 10.0.0.2 '] });
    expect(updated.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('緊急停止は既定 false、切り替えできる', async () => {
    expect((await getSecuritySettings()).emergencyStop).toBe(false);
    expect((await updateSecuritySettings({ emergencyStop: true })).emergencyStop).toBe(true);
  });
});
