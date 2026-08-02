import { describe, expect, it, vi } from 'vitest';
import { createLocalVoiceSessionFactory, shouldUseLocalVoiceOrchestrator } from './local-mode';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';

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
    const factory = createLocalVoiceSessionFactory(DIRECTORY, ['山田 太郎']);
    const emit = vi.fn();
    const controller = factory(emit, {});

    await controller.start();
    await controller.close();

    // 起動・終了が例外なく通る（loopback socket が開通し、mock provider が噛み合う）。
    expect(emit).toHaveBeenCalled();
  });

  it('候補が空でも起動できる（担当者が居ない画面で落ちない）', async () => {
    const factory = createLocalVoiceSessionFactory({ staff: [], departments: [] }, []);
    const controller = factory(vi.fn(), {});
    await expect(controller.start()).resolves.not.toThrow();
    await controller.close();
  });
});
