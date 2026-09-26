/**
 * セキュリティ設定の同時更新で変更が消えないこと (#1158)。
 *
 * ## 守る不変条件（機構より先に書く）
 *
 * > **`updateSecuritySettings` が成功を返した ⟹ その patch が書いたフィールドは、
 * > 同時に成功した他の更新が同じフィールドを書かない限り、最終的な記録に残っている。**
 * > **成功しなかった ⟹ 例外（`SecuritySettingsConflictError`）で、黙って勝たない。**
 *
 * - 版（`rev`）付きの patch は「その版から見た変更」である。読んだ時点の版と違えば
 *   **1 バイトも書かず**に競合を返す（管理画面の古い表示からの保存が、他人の変更を消さない）
 * - 版なしの patch（緊急停止のトグル等）は最新の記録へ当て直す。**押した緊急停止が
 *   他の保存に踏み潰されない**のがこの issue の本題（#1158 AC3）
 * - 下界: 並行しなければ全部成功し、版は書くたびに 1 つずつ進む。旧レコード（版なし）も読めて書ける
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULT_PIN } from '@/domain/security/pin';
import type { SecuritySettings } from '@/domain/security/types';
import { getBackend } from '@/lib/data';
import {
  __resetSecurity,
  getSecuritySettings,
  SecuritySettingsConflictError,
  SecuritySettingsInvalidError,
  updateSecuritySettings,
  verifyPin,
} from './security-store';

const raw = () => getBackend().singleton<SecuritySettings>('security', { default: () => ({}) as SecuritySettings });

beforeEach(async () => {
  await __resetSecurity();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 2 つの更新を**必ず**交差させる: 両方が読み終えるまで、どちらの書き込みも通さない。
 * 自然な `Promise.all` の交差に任せると、実行順しだいで「たまたま直列だった」緑になる。
 */
function interleaveReads(n: number): void {
  const store = raw();
  const get = store.get.bind(store);
  let waiting: Array<() => void> = [];
  let reads = 0;
  vi.spyOn(store, 'get').mockImplementation(async () => {
    const v = await get();
    reads += 1;
    if (reads <= n) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === n) {
          const all = waiting;
          waiting = [];
          all.forEach((r) => r());
        }
      });
    }
    return v;
  });
}

type Patch = Record<string, unknown>;
/** フィールドの素な組。どの 2 つを同時に書いても、互いの変更が残るべきもの。 */
const DISJOINT: ReadonlyArray<readonly [string, Patch, (s: SecuritySettings) => Promise<boolean>]> = [
  ['緊急停止', { emergencyStop: true }, async (s) => s.emergencyStop === true],
  ['PIN', { pin: '4821' }, async () => verifyPin('4821')],
  ['PIN 必須', { pinRequired: true }, async (s) => s.pinRequired === true],
  ['IP 許可リスト', { ipAllowlist: ['203.0.113.7'] }, async (s) => s.ipAllowlist.includes('203.0.113.7')],
];

describe('セキュリティ設定の同時更新 (#1158)', () => {
  /**
   * 🔴 **本題。** 「別の運用者が PIN を保存中に、こちらが緊急停止を押す」と、相手の書き込みが
   * **緊急停止を落とした状態**を書き戻していた（lost update）。素なフィールドの全組で縛る。
   */
  for (const [la, pa, has_a] of DISJOINT) {
    for (const [lb, pb, has_b] of DISJOINT) {
      if (la >= lb) continue;
      it(`🔴 ${la} と ${lb} を同時に保存しても、どちらも消えない`, async () => {
        interleaveReads(2);
        await Promise.all([updateSecuritySettings(pa), updateSecuritySettings(pb)]);
        vi.restoreAllMocks();
        // PIN の検査は pinRequired が要るので、確認用に立てる（他のフィールドは触らない）。
        const s = await getSecuritySettings();
        const check = { ...s };
        if (la === 'PIN' || lb === 'PIN') await updateSecuritySettings({ pinRequired: true });
        expect(await has_a(check)).toBe(true);
        expect(await has_b(check)).toBe(true);
      });
    }
  }

  /** 🔴 版付きの patch は、読んだ版から動いていれば書かない（黙って勝たない）。 */
  it('🔴 古い版からの保存は競合になり、記録は変わらない', async () => {
    const first = await updateSecuritySettings({ pinRequired: true });
    const staleRev = first.rev ?? 0;
    await updateSecuritySettings({ emergencyStop: true });
    const before = await raw().get();
    await expect(
      updateSecuritySettings({ rev: staleRev, pinRequired: false, ipAllowlist: [] }),
    ).rejects.toBeInstanceOf(SecuritySettingsConflictError);
    expect(await raw().get()).toEqual(before);
    // 他人が入れた緊急停止は残っている。
    expect((await getSecuritySettings()).emergencyStop).toBe(true);
  });

  /** 🔴 版付き同士が同時に来たら、勝つのは 1 つで、もう 1 つは競合になる。 */
  it('🔴 同じ版からの保存が 2 つ重なれば、1 つは競合になる', async () => {
    const { rev } = await updateSecuritySettings({ pinRequired: false });
    interleaveReads(2);
    const results = await Promise.allSettled([
      updateSecuritySettings({ rev, ipAllowlist: ['203.0.113.1'] }),
      updateSecuritySettings({ rev, ipAllowlist: ['203.0.113.2'] }),
    ]);
    vi.restoreAllMocks();
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicted = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof SecuritySettingsConflictError,
    );
    expect(ok).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
  });

  /** 🔴 下界: 現在の版からの保存は通り、版は 1 つ進む。 */
  it('現在の版からの保存は通り、版は書くたびに 1 つ進む', async () => {
    const a = await updateSecuritySettings({ pinRequired: true });
    const b = await updateSecuritySettings({ rev: a.rev, ipAllowlist: ['203.0.113.9'] });
    const c = await updateSecuritySettings({ emergencyStop: true });
    expect(b.rev).toBe((a.rev ?? 0) + 1);
    expect(c.rev).toBe((b.rev ?? 0) + 1);
    expect((await getSecuritySettings()).rev).toBe(c.rev);
  });

  /** 🔴 旧レコード（版を持たない）も読めて、版 0 として扱い、書ける（互換）。 */
  it('🔴 版を持たない旧レコードは版 0 として読めて書ける', async () => {
    await raw().put({ pinRequired: true, pin: BUILTIN_DEFAULT_PIN, ipAllowlist: [], emergencyStop: false });
    expect((await getSecuritySettings()).rev ?? 0).toBe(0);
    const updated = await updateSecuritySettings({ rev: 0, emergencyStop: true });
    expect(updated.rev).toBe(1);
    expect(updated.emergencyStop).toBe(true);
  });

  /**
   * 🔴 **当て直しにも上限がある。** 書き込みが毎回負けるなら、黙って諦めず競合を返す。
   * 上限が無いと、未認証ではないにせよ 1 つの要求が無限に回る。
   */
  it('🔴 書き込みが負け続ければ競合を返し、何も書かない', async () => {
    const store = raw();
    const putIf = vi.spyOn(store, 'putIf').mockResolvedValue(false);
    const before = await store.get();
    await expect(updateSecuritySettings({ emergencyStop: true })).rejects.toBeInstanceOf(
      SecuritySettingsConflictError,
    );
    // 当て直しの回数は上限ちょうど（広げる変異も狭める変異もここで落ちる。独立レビュー 3 周目 MINOR）。
    expect(putIf.mock.calls.length).toBe(3);
    vi.restoreAllMocks();
    expect(await store.get()).toEqual(before);
  });

  /** 🔴 版の形が違う patch は、無視して黙って勝たせず、不正な入力として拒否する。 */
  it.each([-1, 1.5, '3', null, Number.NaN])('🔴 不正な版 %s は拒否し、書かない', async (bad) => {
    const before = await raw().get();
    await expect(updateSecuritySettings({ rev: bad, emergencyStop: true })).rejects.toBeInstanceOf(
      SecuritySettingsInvalidError,
    );
    expect(await raw().get()).toEqual(before);
  });

  /**
   * 🔴 **当て直しの下界。** 管理者が数人同時に触る程度（2 回負ける）では、押した緊急停止は
   * 落ちない。上限を狭める変異（数値パラメータ）はここでしか縛れない。
   */
  it('🔴 版なしの更新は 2 回負けても 3 回目で通る', async () => {
    const store = raw();
    const real = store.putIf.bind(store);
    vi.spyOn(store, 'putIf')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockImplementation(real);
    await updateSecuritySettings({ emergencyStop: true });
    vi.restoreAllMocks();
    expect((await getSecuritySettings()).emergencyStop).toBe(true);
  });

  /**
   * 🔴 **壊れた版で締め出さない。** 版の形が壊れた記録（外部からの書き込み・将来版）でも
   * 版 0 として読み、その版からの保存も緊急停止も通る。締め出すと、**緊急停止が
   * 管理画面から押せなくなる**（この issue が守ろうとしている面そのもの）。
   */
  it.each([-1, 1.5, 'x', Number.NaN])('🔴 版が壊れた記録 %s でも、版 0 からの保存と緊急停止が通る', async (broken) => {
    await raw().put({
      pinRequired: false,
      pin: BUILTIN_DEFAULT_PIN,
      ipAllowlist: [],
      emergencyStop: false,
      rev: broken as number,
    });
    const saved = await updateSecuritySettings({ rev: 0, pinRequired: true });
    expect(saved.rev).toBe(1);
    const stopped = await updateSecuritySettings({ emergencyStop: true });
    expect(stopped.emergencyStop).toBe(true);
  });

  /**
   * 🔴 **版なしの patch は、送ったフィールドについては後勝ちである（意図した非対称）。**
   *
   * 版なしで受け付けるのは、緊急停止のトグルを競合で落とさないため（#1158 AC3）。
   * 管理画面のフォームは必ず版を付けるので守られるが、**版を付けずに同じフィールドを送る
   * 呼び出し元（API を直接叩くスクリプト等）同士は後勝ちになる**。版を必須にするのは
   * 管理 API の契約変更なので、人間の判断へ回している（PR 本文）。ここでは現状を固定し、
   * 変えたときにこのテストが赤くなるようにする。送らなかったフィールドは消えない（下界）。
   */
  it('版なしの patch 同士が同じフィールドを書けば後勝ちで、送らなかったフィールドは残る', async () => {
    await updateSecuritySettings({ emergencyStop: true });
    interleaveReads(2);
    await Promise.all([
      updateSecuritySettings({ ipAllowlist: ['203.0.113.1'] }),
      updateSecuritySettings({ ipAllowlist: ['203.0.113.2'] }),
    ]);
    vi.restoreAllMocks();
    const s = await getSecuritySettings();
    expect(s.ipAllowlist).toHaveLength(1);
    expect(['203.0.113.1', '203.0.113.2']).toContain(s.ipAllowlist[0]);
    expect(s.emergencyStop).toBe(true);
  });
});
