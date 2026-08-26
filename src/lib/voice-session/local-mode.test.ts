import { describe, expect, it, vi } from 'vitest';
import { createLocalVoiceSessionFactory, shouldUseLocalVoiceOrchestrator } from './local-mode';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import { RECEPTION_STATES } from '@/domain/reception/state';

const DIRECTORY: EntityDirectory = {
  staff: [
    {
      id: 'staff-1',
      displayName: '山田 太郎',
      aliases: [],
      departmentId: 'dept-1',
      enabled: true,
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    },
  ],
  departments: [{ id: 'dept-1', name: '営業部', displayOrder: 0, enabled: true }],
};

/**
 * 実 orchestrator のローカル起動 (#372 配線)。
 *
 * ここまで `VoiceSessionOrchestrator` は**本番呼び出し元がゼロ**で、一度も起動していなかった。
 * 実音声（#369/#370）を繋ぐ前に、mock provider で通る経路を作って挙動を確かめられるようにする。
 */
describe('shouldUseLocalVoiceOrchestrator', () => {
  /** **既定はオフ。** 付けた端末だけが対象で、既存の受付挙動を変えない。 */
  it('クエリが無ければ false', () => {
    expect(shouldUseLocalVoiceOrchestrator('')).toBe(false);
    expect(shouldUseLocalVoiceOrchestrator('?other=1')).toBe(false);
  });

  it('?voiceOrchestrator=1 のときだけ true', () => {
    expect(shouldUseLocalVoiceOrchestrator('?voiceOrchestrator=1')).toBe(true);
    expect(shouldUseLocalVoiceOrchestrator('?voiceOrchestrator=0')).toBe(false);
  });
});

describe('createLocalVoiceSessionFactory', () => {
  /**
   * **実 orchestrator が起動すること**が要点。ここが動かないと、ターン検出も barge-in も
   * 「作ってあるが一度も起動しない」ままになる。
   */
  it('start でセッションが開始し、close で閉じられる', async () => {
    const factory = createLocalVoiceSessionFactory(DIRECTORY);
    const controller = factory(vi.fn(), {});

    await expect(controller.start()).resolves.not.toThrow();
    await expect(controller.close()).resolves.not.toThrow();
  });

  it('Directory が空でも起動できる（担当者が居ない画面で落ちない）', async () => {
    const factory = createLocalVoiceSessionFactory({ staff: [], departments: [] });
    const controller = factory(vi.fn(), {});
    await expect(controller.start()).resolves.not.toThrow();
    await controller.close();
  });

  /**
   * 合成発話の起点 (#788)。
   *
   * 🔴 **来訪者が一言も発していない局面で相手を確定しない。** セッションは idle でも
   * 構成取得の着地でも start する。そこで喋ると、高信頼・候補 1 件の合成発話が復唱を
   * 挟まず `heardAccepted` まで通り、`onResolved` → `SELECT_TARGET` が撃たれる。
   * 実 Directory を渡す前（空辞書）は候補ゼロで無害だったので、実害はこの配線で初めて出る。
   */
  describe('合成発話は相手選択への到達だけを起点にする (#788)', () => {
    async function started(directory: EntityDirectory = DIRECTORY) {
      const onResolved = vi.fn();
      const emit = vi.fn();
      const controller = createLocalVoiceSessionFactory(directory)(emit, { onResolved });
      await controller.start();
      return { controller, onResolved, emit };
    }

    /**
     * **上界**: 相手選択に居ない限り、どの局面の通知でも相手は確定しない。
     * `selectingTarget` 以外の全局面を総当たりする（1 つでも通ると、来訪者が押していない
     * 相手へ勝手に進む）。
     */
    it('selectingTarget 以外では、どの局面でも相手を確定しない', async () => {
      for (const state of RECEPTION_STATES.filter((s) => s !== 'selectingTarget')) {
        const { controller, onResolved } = await started();
        controller.notifyReceptionState?.(state);
        expect(onResolved, `state=${state}`).not.toHaveBeenCalled();
        await controller.close();
      }
    });

    /** start しただけ（通知なし）でも確定しない。 */
    it('start しただけでは相手を確定しない', async () => {
      const { controller, onResolved } = await started();
      expect(onResolved).not.toHaveBeenCalled();
      await controller.close();
    });

    /**
     * **下界**: 上界だけなら「何も喋らない」実装で空虚に満たせる。相手選択へ到達したら
     * 実際に解決まで通ることを併せて縛る（#788 の狙いそのもの）。
     */
    it('selectingTarget へ到達したら在席担当者へ解決する', async () => {
      const { controller, onResolved } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }));
      await controller.close();
    });

    /**
     * 🔴 **再到達で喋り直さない。** 来訪者が「戻る」で選び直そうとした瞬間に同じ相手が
     * 再確定すると、相手選択画面から抜けられなくなる。
     *
     * 🔴 **ターンを畳んでから戻る**こと。復唱確認の確定（`confirmYes`）は orchestrator の
     * ターンを reset するので、「一度確定した」というターン側の状態は残らない。
     * ここを踏まないと、1 回制限を外す変異が**素通りする**（実測で生存した）。
     */
    it('相手選択へ再到達しても 2 度目は喋らない', async () => {
      const { controller, onResolved } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      controller.confirmYes();
      controller.notifyReceptionState?.('inputVisitorInfo');
      controller.notifyReceptionState?.('selectingTarget');
      // `confirmYes` 自体は保留候補（ここでは null）を流すので、相手が決まった回数だけ数える。
      const resolvedTargets = onResolved.mock.calls.filter(([candidate]) => candidate !== null);
      expect(resolvedTargets).toHaveLength(1);
      await controller.close();
    });

    /** Directory が空（未取得・在席者ゼロ）なら、到達しても何も起きない。 */
    it('Directory が空なら selectingTarget でも確定しない', async () => {
      const { controller, onResolved } = await started({ staff: [], departments: [] });
      controller.notifyReceptionState?.('selectingTarget');
      expect(onResolved).not.toHaveBeenCalled();
      await controller.close();
    });
  });
});
