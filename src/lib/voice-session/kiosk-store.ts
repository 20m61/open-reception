/**
 * `VoiceKioskStore` — Kiosk 音声対話 UI の外部ストア (issue #364 kiosk 配線)。
 *
 * `VoiceSessionFactory`（synthetic or 実 orchestrator wrapper）を受け取り、その emit を
 * `voiceKioskReducer`（純状態機械）へ流し込む。React 側は `useSyncExternalStore` でこのストアを購読する
 * （`src/components/kiosk/useVoiceSession.ts`）。ストア自体は React に依存しないので node 環境で単体テスト
 * できる（demo-studio のシナリオ再現もこのストアで完結する）。
 *
 * 単一入口の原則: 復唱確認の「はい/いいえ」はタッチボタンでも音声「はい/いいえ」でも `confirmYes`/
 * `confirmNo` の一本に集約する（controller 経由）。UI は状態のみを描画し、判断はここに一元化する。
 */
import {
  initialVoiceKioskState,
  voiceKioskReducer,
  type VoiceKioskEvent,
  type VoiceKioskState,
} from '@/domain/voice-session/kiosk-view';
import type { VoiceSessionController, VoiceSessionFactory } from './kiosk-binding';

export class VoiceKioskStore {
  private state: VoiceKioskState = initialVoiceKioskState();
  private readonly listeners = new Set<() => void>();
  private readonly controller: VoiceSessionController;

  constructor(factory: VoiceSessionFactory) {
    // factory へ emit を渡し、駆動可能な controller を得る。emit は reducer へ dispatch する。
    this.controller = factory((event) => this.dispatch(event));
  }

  /** 現在状態のスナップショット（変化が無ければ同一参照を保つ）。 */
  getState = (): VoiceKioskState => this.state;

  /** 状態変化の購読。戻り値で解除する。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 音声モードを活性化し、配下セッションを開始する。 */
  start = (): void => {
    this.dispatch({ type: 'activate' });
    void this.controller.start();
  };

  /** 音声モードを解除し、配下セッションを閉じる（タッチ受付へ戻す）。 */
  close = (): void => {
    void this.controller.close();
    this.dispatch({ type: 'deactivate' });
  };

  /** 復唱確認「はい」（タッチ/音声 共通入口）。 */
  confirmYes = (): void => {
    this.controller.confirmYes();
  };

  /** 復唱確認「いいえ」（タッチ/音声 共通入口）。 */
  confirmNo = (): void => {
    this.controller.confirmNo();
  };

  private dispatch(event: VoiceKioskEvent): void {
    const next = voiceKioskReducer(this.state, event);
    if (next === this.state) return; // 無変化なら通知しない（スナップショット安定性）。
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
