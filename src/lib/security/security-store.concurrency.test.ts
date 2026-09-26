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
  revisionOf,
  SecuritySettingsConflictError,
  SecuritySettingsInvalidError,
  SecuritySettingsPreconditionRequiredError,
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
/**
 * フィールドの素な組。管理画面と同じ形で送る: フォームの項目は**読んだ版（0）を付けて**、
 * 緊急停止は版なしのトグルで送る（版なしで受け付けるのは緊急停止だけ）。
 */
const DISJOINT: ReadonlyArray<readonly [string, Patch, (s: SecuritySettings) => Promise<boolean>]> = [
  ['緊急停止', { emergencyStop: true }, async (s) => s.emergencyStop === true],
  ['PIN', { rev: 0, pin: '4821' }, async () => verifyPin('4821')],
  ['PIN 必須', { rev: 0, pinRequired: true }, async (s) => s.pinRequired === true],
  ['IP 許可リスト', { rev: 0, ipAllowlist: ['203.0.113.7'] }, async (s) => s.ipAllowlist.includes('203.0.113.7')],
];

describe('セキュリティ設定の同時更新 (#1158)', () => {
  /**
   * 🔴 **本題。** 「別の運用者が PIN を保存中に、こちらが緊急停止を押す」と、相手の書き込みが
   * **緊急停止を落とした状態**を書き戻していた（lost update）。素なフィールドの全組で、
   * 読みを必ず交差させて縛る:
   *
   * - 成功した更新の変更は、必ず最終的な記録に残る（黙って消えない）
   * - 成功しなかった更新は競合（409）で、黙って負けていない
   * - 下界: 緊急停止は負けない（当て直す）。全部が競合になる実装で空虚に満たさない
   */
  for (const [la, pa, has_a] of DISJOINT) {
    for (const [lb, pb, has_b] of DISJOINT) {
      if (la >= lb) continue;
      it(`🔴 ${la} と ${lb} を同時に保存しても、成功した変更は消えず、負けた側は競合になる`, async () => {
        interleaveReads(2);
        const results = await Promise.allSettled([updateSecuritySettings(pa), updateSecuritySettings(pb)]);
        vi.restoreAllMocks();
        // PIN の検査は pinRequired が要るので、確認用に立てる（他のフィールドは触らない）。
        const check = { ...(await getSecuritySettings()) };
        if (la === 'PIN' || lb === 'PIN') await updateSecuritySettings({ rev: check.rev, pinRequired: true });
        const pairs = [
          [results[0], has_a, la],
          [results[1], has_b, lb],
        ] as const;
        for (const [result, has, label] of pairs) {
          if (result.status === 'fulfilled') expect(await has(check), `${label} が消えた`).toBe(true);
          else expect(result.reason, label).toBeInstanceOf(SecuritySettingsConflictError);
          if (label === '緊急停止') expect(result.status, '緊急停止が負けた').toBe('fulfilled');
        }
        expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      });
    }
  }

  /** 🔴 版付きの patch は、読んだ版から動いていれば書かない（黙って勝たない）。 */
  it('🔴 古い版からの保存は競合になり、記録は変わらない', async () => {
    const first = await updateSecuritySettings({ rev: 0, pinRequired: true });
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
    const { rev } = await updateSecuritySettings({ rev: 0, pinRequired: false });
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
    const a = await updateSecuritySettings({ rev: 0, pinRequired: true });
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
   * 🔴 **版なしで受け付けるのは緊急停止のトグルだけ（ユーザー判断で必須化）。**
   *
   * 以前は版なしの patch を全部受け付けて最新の記録へ当て直していたので、API を直接叩く
   * 呼び出し元同士は**送ったフィールドについて後勝ち**だった（独立レビュー 1 周目 MAJOR）。
   * 版の無い更新は「読んだ後に誰が何を書いたか」を判定できないので、受け付けない（428）。
   * 許可の列挙なので、緊急停止に何か 1 つでも混ぜれば版を要求する。何も書かない（下界）。
   */
  it.each([
    ['PIN 必須', { pinRequired: true }],
    ['PIN', { pin: '4821' }],
    ['IP 許可リスト', { ipAllowlist: ['203.0.113.1'] }],
    ['緊急停止に他の項目を混ぜたもの', { emergencyStop: true, ipAllowlist: [] }],
    ['緊急停止の値が boolean でないもの', { emergencyStop: 'true' }],
    ['空の patch', {}],
    ['null', null],
    ['配列', [{ emergencyStop: true }]],
  ] as const)('🔴 版なしの %s は 428 相当で、何も書かない', async (_label, patch) => {
    await updateSecuritySettings({ rev: 0, pinRequired: false, ipAllowlist: ['203.0.113.9'] });
    const before = await raw().get();
    await expect(updateSecuritySettings(patch)).rejects.toBeInstanceOf(
      SecuritySettingsPreconditionRequiredError,
    );
    expect(await raw().get()).toEqual(before);
  });

  /** 下界: 版なしの緊急停止トグルは受け付ける（開始も解除も）。 */
  it.each([true, false])('版なしの緊急停止トグル（%s）は受け付ける', async (value) => {
    await updateSecuritySettings({ emergencyStop: !value });
    const updated = await updateSecuritySettings({ emergencyStop: value });
    expect(updated.emergencyStop).toBe(value);
  });

  /**
   * 🔴 **同時の投入と解除で、投入は負けない (#1158 AC3。fresh-context review M1)。**
   *
   * 以前は解除（`emergencyStop: false`）も版なしで当て直していたので、投入と解除が交錯すると
   * **両方が成功と返り、最終値は解除**になった（順序によらず。実測）。投入した運用者の画面は
   * 「有効にしました」のまま停止が黙って外れる。当て直すのは投入だけにし、解除は 1 回だけ試して
   * 負けたら競合にする。順序を両方向で縛る。
   */
  it.each([
    ['投入が先', [true, false]],
    ['解除が先', [false, true]],
  ] as const)('🔴 投入と解除が交錯しても（%s）、投入は成功し最終値は停止のまま', async (_label, order) => {
    await updateSecuritySettings({ emergencyStop: false });
    interleaveReads(2);
    const results = await Promise.allSettled(order.map((v) => updateSecuritySettings({ emergencyStop: v })));
    vi.restoreAllMocks();
    const stop = results[order.indexOf(true)];
    const resume = results[order.indexOf(false)];
    expect(stop?.status).toBe('fulfilled');
    expect((await getSecuritySettings()).emergencyStop).toBe(true);
    // 解除は「勝った（その後で投入が当て直した）」か「競合」のどちらか。黙って負けて成功とは言わない。
    if (resume?.status === 'rejected') expect(resume.reason).toBeInstanceOf(SecuritySettingsConflictError);
  });

  /** 🔴 解除は当て直さない: 1 回負けたら競合（下界として 1 回は試す）。 */
  it('🔴 版なしの解除は 1 回負けたら競合で、当て直さない', async () => {
    await updateSecuritySettings({ emergencyStop: true });
    const store = raw();
    const putIf = vi.spyOn(store, 'putIf').mockResolvedValue(false);
    await expect(updateSecuritySettings({ emergencyStop: false })).rejects.toBeInstanceOf(
      SecuritySettingsConflictError,
    );
    expect(putIf).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    expect((await getSecuritySettings()).emergencyStop).toBe(true);
  });

  /** 🔴 security の singleton は強い整合性で読む（配線。#1158 fresh-context review M2）。 */
  it('security の singleton を consistentRead で開く', async () => {
    const backend = getBackend();
    const spy = vi.spyOn(backend, 'singleton');
    await getSecuritySettings();
    expect(spy).toHaveBeenCalledWith('security', expect.objectContaining({ consistentRead: true }));
  });

  /**
   * 🔴 **版が安全な整数の外なら、進まない版で ABA にしない (fresh-context review L1)。**
   * `2^53 + 1 === 2^53` なので、以前は版が進まず、同じ版を読んだ 2 つの保存が順に両方通った。
   * 安全な整数の外は壊れた版として 0 と読み、書けば 1 から進み直す。
   */
  it.each([2 ** 53, 2 ** 60])('🔴 版 %s の記録でも、同じ版からの 2 本目の保存は競合になる', async (huge) => {
    await raw().put({ pinRequired: false, pin: BUILTIN_DEFAULT_PIN, ipAllowlist: [], emergencyStop: false, rev: huge });
    const rev = revisionOf((await getSecuritySettings()).rev);
    expect(rev).toBe(0);
    const first = await updateSecuritySettings({ rev, pinRequired: true });
    expect(first.rev).toBe(1);
    await expect(updateSecuritySettings({ rev, ipAllowlist: [] })).rejects.toBeInstanceOf(
      SecuritySettingsConflictError,
    );
  });

  it.each([2 ** 53, Number.MAX_SAFE_INTEGER + 2])('🔴 安全な整数の外の版 %s を送ったら不正な版として拒否する', async (bad) => {
    await expect(updateSecuritySettings({ rev: bad, pinRequired: true })).rejects.toBeInstanceOf(
      SecuritySettingsInvalidError,
    );
  });
});
