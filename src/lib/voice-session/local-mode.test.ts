import { describe, expect, it, vi } from 'vitest';
import {
  createLocalVoiceSessionFactory,
  driveWithSyntheticAudio,
  shouldUseLocalVoiceOrchestrator,
} from './local-mode';
import { VoiceSessionOrchestrator } from './orchestrator';
import { createMockSttProvider } from '@/lib/voice-stt/mock-provider';
import { MockStreamingTtsProvider } from '@/lib/voice-tts/mock-provider';
import { InMemoryTtsCache } from '@/lib/voice-tts/cache-store';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import type { VoiceTransportSocket } from '@/lib/voice-transport/socket';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
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
        const { controller, onResolved, emit } = await started();
        controller.notifyReceptionState?.(state);
        // 🔴 `onResolved` だけを見ると**復唱を挟む今の実装では空虚に通る**（確定は「はい」の後）。
        // 喋ったかどうかは emit で見る。
        expect(emit, `state=${state}`).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'heardNeedsConfirmation' }),
        );
        expect(onResolved, `state=${state}`).not.toHaveBeenCalled();
        await controller.close();
      }
    });

    /** start しただけ（通知なし）でも確定しない。 */
    it('start しただけでは喋らない', async () => {
      const { controller, onResolved, emit } = await started();
      expect(emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heardNeedsConfirmation' }),
      );
      expect(onResolved).not.toHaveBeenCalled();
      await controller.close();
    });

    /**
     * **下界**: 上界だけなら「何も喋らない」実装で空虚に満たせる。相手選択へ到達したら
     * 実際に候補が立つことを併せて縛る（#788 の狙いそのもの）。
     */
    it('selectingTarget へ到達したら在席担当者を復唱する', async () => {
      const { controller, emit } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heardNeedsConfirmation', displayName: '山田 太郎' }),
      );
      await controller.close();
    });

    /**
     * 🔴 **来訪者に見えないまま相手を確定しない。** 高信頼で流すと復唱を挟まず
     * `heardAccepted` まで通り、相手選択画面が 1 フレームで消えて別の相手を選べなくなる。
     * 確定は必ず「はい」の後。
     */
    it('復唱に「はい」と答えるまで相手は確定しない', async () => {
      const { controller, onResolved } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      expect(onResolved).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }));

      controller.confirmYes();
      expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff-1' }));
      await controller.close();
    });

    /** 「いいえ」なら確定しない（取り消し口が生きている）。 */
    it('復唱に「いいえ」と答えたら相手は確定しない', async () => {
      const { controller, onResolved } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      controller.confirmNo();
      const resolvedTargets = onResolved.mock.calls.filter(([candidate]) => candidate !== null);
      expect(resolvedTargets).toHaveLength(0);
      await controller.close();
    });

    /**
     * 🔴 **待機へ戻ったら次の来訪者。** `spokenAlready` は音声セッション（store）の寿命に
     * 紐づき、store は `directory` の identity が変わるまで作り直されない。版スナップショットを
     * 持つ拠点では identity が変わらないので、再武装しないと**2 人目以降は端末を再読込するまで
     * 永久に音声で相手を選べない**。
     */
    it('受付が待機へ戻ったら、次の来訪者では再び復唱する', async () => {
      const { controller, emit } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      controller.confirmYes();
      // 来訪者 1 の受付が終わって待機へ戻る。
      for (const state of ['inputVisitorInfo', 'confirming', 'calling', 'completed', 'idle'] as const) {
        controller.notifyReceptionState?.(state);
      }
      // 来訪者 2。
      const before = emit.mock.calls.filter(([e]) => e.type === 'heardNeedsConfirmation').length;
      controller.notifyReceptionState?.('selectingPurpose');
      controller.notifyReceptionState?.('selectingTarget');
      const after = emit.mock.calls.filter(([e]) => e.type === 'heardNeedsConfirmation').length;
      expect(after).toBe(before + 1);
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
    it('同じ受付の中で相手選択へ再到達しても 2 度目は喋らない', async () => {
      const { controller, onResolved } = await started();
      controller.notifyReceptionState?.('selectingTarget');
      controller.confirmYes();
      // 待機（idle）を経由しない = 同じ来訪者が「戻る」で選び直そうとしている。
      controller.notifyReceptionState?.('inputVisitorInfo');
      controller.notifyReceptionState?.('selectingTarget');
      // `confirmYes` 自体は保留候補（消費後は null）も流すので、相手が決まった回数だけ数える。
      const resolvedTargets = onResolved.mock.calls.filter(([candidate]) => candidate !== null);
      expect(resolvedTargets).toHaveLength(1);
      await controller.close();
    });

    /** Directory が空（未取得・在席者ゼロ）なら、到達しても何も起きない。 */
    it('Directory が空なら selectingTarget でも喋らない', async () => {
      const { controller, onResolved, emit } = await started({ staff: [], departments: [] });
      controller.notifyReceptionState?.('selectingTarget');
      expect(onResolved).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heardNeedsConfirmation' }),
      );
      await controller.close();
    });
  });
});

/**
 * 合成駆動の忠実度 (#788 レビュー 2 周目 MINOR-2)。
 *
 * 本モジュールの存在理由は「実 orchestrator を mock provider で**通す**」こと。ところが
 * ターン確定に要る文字列は `reportSpeechEnded` が運ぶので、**マイクチャンクを 1 つも
 * 流さなくても UI の結果は変わらない**。上位の seam（`emit` / `onResolved`）からは
 * 区別できず、実際に「チャンク数を 3→0 にする」「`reportSpeechStarted` を消す」変異が
 * どちらも生き残った。transport 送出・STT session 供給・遅延計測イベントが黙って空に
 * なっていないことを、orchestrator の eval ストリームで直接縛る。
 */
describe('driveWithSyntheticAudio の忠実度 (#788)', () => {
  function build(onEvalEvent: (event: VoiceEvalEvent) => void): VoiceSessionOrchestrator {
    return new VoiceSessionOrchestrator(
      {
        transport: {
          url: 'loopback://voice',
          socketFactory: () => {
            const socket: VoiceTransportSocket = {
              onopen: null,
              onclose: null,
              onerror: null,
              onmessage: null,
              send: () => {},
              close: (code = 1000, reason = 'test') => socket.onclose?.({ code, reason }),
            };
            queueMicrotask(() => socket.onopen?.());
            return socket;
          },
          queueLimits: { maxChunks: 64, maxBytes: 1024 * 1024, dropPolicy: 'drop-oldest' },
          rateLimit: { capacity: 64, refillPerMs: 1 },
          heartbeatIntervalMs: 30_000,
          heartbeatTimeoutMs: 60_000,
          idleTimeoutMs: 300_000,
          reconnect: { backoff: { baseMs: 1000, maxMs: 1000 }, maxAttempts: 0 },
        },
        stt: { locale: 'ja-JP', audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG },
      },
      {
        sttProvider: createMockSttProvider({
          partials: [{ afterChunk: 1, text: '山田', confidence: 0.4 }],
          final: { afterChunk: 2, text: '山田 太郎', confidence: 0.4 },
        }),
        ttsProvider: new MockStreamingTtsProvider(),
        ttsCache: new InMemoryTtsCache(),
      },
      { onEvalEvent },
    );
  }

  it('発話開始・STT の partial/final・発話終了がすべて観測できる', async () => {
    const events: VoiceEvalEvent[] = [];
    const orchestrator = build((event) => events.push(event));
    await orchestrator.start();

    driveWithSyntheticAudio(orchestrator, '山田 太郎');
    // mock STT の push は非同期なので、マイクロタスクを 1 巡させる。
    await Promise.resolve();
    await Promise.resolve();

    const types = events.map((e) => e.type);
    // 発話開始（= 遅延計測の起点）。消すと `audio.onset` が出なくなる。
    expect(types).toContain('audio.onset');
    // 🔴 **STT を実際に駆動していること。** チャンクを流さないと partial も final も出ない
    // （UI の結果は変わらないので、ここで見ないと誰も気づけない）。
    expect(types).toContain('stt.partial');
    expect(types).toContain('stt.final');

    await orchestrator.close();
  });

  it('発話が空なら何も駆動しない', async () => {
    const events: VoiceEvalEvent[] = [];
    const orchestrator = build((event) => events.push(event));
    await orchestrator.start();
    const before = events.length;

    driveWithSyntheticAudio(orchestrator, '');
    await Promise.resolve();

    expect(events.length).toBe(before);
    await orchestrator.close();
  });
});
