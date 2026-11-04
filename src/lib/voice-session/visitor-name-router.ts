import type { ReceptionState } from '@/domain/reception/state';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import {
  VISITOR_NAME_ANSWER_TIMEOUT_MS,
  initialVisitorNameCapture,
  stepVisitorNameCapture,
  type VisitorNameCapture,
  type VisitorNameCaptureEffect,
  type VisitorNameCaptureEvent,
} from '@/domain/voice-session/visitor-name-capture';

/**
 * 音声セッションの結線（synthetic / 実 orchestrator の両方）で、確定した発話を
 * 「氏名の聞き取り」（`visitor-name-capture.ts`）へ回す層 (ADR 0011、#1290)。
 *
 * - `inputVisitorInfo` に居るあいだの発話は、全部ここが受け取る（相手の解決へは回さない。
 *   相手は前の画面で確定済みで、`SELECT_TARGET` はこの画面では起きない）。
 * - 画面の出入りは `notifyReceptionState`、通知の結果・キーボード入力は `visitorName` で受ける。
 * - 効果を UI イベント（`VoiceKioskEvent`）と `onVisitorNameConfirmed` へ写す。外へ出すのはこの 2 つだけ。
 * - 画面を出たら、途中のターン（`resetTurn`）と待ち時間を捨てる。遅れて届いた発話は使わない（§6）。
 *
 * PII: 発話・氏名をログへ出さない。氏名は UI イベントと `onVisitorNameConfirmed` にだけ渡す。
 */

/** 待ち時間のタイマー。戻り値で取り消す。テストで差し替える。 */
export type VisitorNameTimer = (fn: () => void, ms: number) => () => void;

/** `KioskFlow` から結線へ知らせる入力（画面の出入り以外）。 */
export type VisitorNameCaptureInput = Extract<
  VisitorNameCaptureEvent,
  { type: 'enter' } | { type: 'noticeFinished' } | { type: 'typing' }
>;

export type VisitorNameRouterDeps = {
  emit: (event: VoiceKioskEvent) => void;
  onVisitorNameConfirmed: (name: string) => void;
  sttConfidence: (text: string) => number;
  /** 途中のターンを捨てる（実 orchestrator の `resetTurn`）。 */
  resetTurn: () => void;
  timer?: VisitorNameTimer;
};

export type VisitorNameRouter = {
  notifyReceptionState(state: ReceptionState): void;
  /**
   * 通知の結果・キーボード入力・画面へ入ったこと（`enter`）を受ける。
   * 戻り値は**いま通知を読み上げるべきか**（入力の後も通知の完了を待つ局面か）。音声レイヤが使うのは
   * `enter` への戻り値だけで、通知を読み上げてよいのは `true` のときだけ (#1290):
   * - 通知の途中の `enter` の再送（言語の切り替え等）は `true`。新しい言語で読み直し、その完了で
   *   尋ねる（前の読み上げの完了は音声レイヤの cleanup が捨てるので、読み直さないと通知の局面に
   *   取り残される）
   * - 通知を読み終えた後の再送は `false`。復唱や来訪者の打鍵の最中に通知を流さない（マイクが
   *   拾えば言い直しの回数まで消費する）
   */
  visitorName(input: VisitorNameCaptureInput): boolean;
  /** 確定した発話を受け取ったら true（相手の解決へは回さない）。 */
  takeTurn(text: string): boolean;
  /** 復唱中のボタンの答えなら true。 */
  confirmYes(): boolean;
  confirmNo(): boolean;
};

const defaultTimer: VisitorNameTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

const SCREEN: ReceptionState = 'inputVisitorInfo';

export function createVisitorNameRouter(deps: VisitorNameRouterDeps): VisitorNameRouter {
  const timer = deps.timer ?? defaultTimer;
  let receptionState: ReceptionState | null = null;
  let capture: VisitorNameCapture = initialVisitorNameCapture();
  let cancelTimer: (() => void) | null = null;

  const stopTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const toUi = (effect: VisitorNameCaptureEffect) => {
    switch (effect.kind) {
      case 'listen':
        deps.emit({ type: 'visitorNameAsk', retry: false });
        return;
      case 'askAgain':
        deps.emit({ type: 'visitorNameAsk', retry: true });
        return;
      case 'readback':
        deps.emit({ type: 'visitorNameReadback', name: effect.name });
        return;
      case 'confirmed':
        deps.emit({ type: 'confirmYes' });
        deps.onVisitorNameConfirmed(effect.name);
        return;
      case 'keyboard':
        deps.emit({ type: 'visitorNameKeyboard' });
        return;
      case 'stopped':
        deps.emit({ type: 'visitorNameStopped' });
        return;
    }
  };

  const apply = (event: VisitorNameCaptureEvent): void => {
    const before = capture;
    const step = stepVisitorNameCapture(capture, event);
    capture = step.state;
    if (step.effect) toUi(step.effect);
    // 何も変えない入力（enter の再送等）では待ち時間を測り直さない。
    if (capture === before) return;
    // 待つのは名乗り・答えを待つ局面だけ。局面へ入り直すたび（言い直し・復唱）に測り直す。
    stopTimer();
    if (capture.phase === 'asking' || capture.phase === 'readback') {
      cancelTimer = timer(() => {
        cancelTimer = null;
        apply({ type: 'noAnswer' });
      }, VISITOR_NAME_ANSWER_TIMEOUT_MS);
    }
  };

  return {
    notifyReceptionState(state) {
      const left = receptionState === SCREEN && state !== SCREEN;
      receptionState = state;
      if (!left) return;
      const wasActive = capture.phase !== 'off';
      apply({ type: 'leave' });
      deps.resetTurn();
      if (wasActive) deps.emit({ type: 'visitorNameStopped' });
    },
    visitorName(input) {
      if (receptionState !== SCREEN) return false;
      apply(input);
      return capture.phase === 'notice';
    },
    takeTurn(text) {
      if (receptionState !== SCREEN) return false;
      deps.resetTurn();
      apply({ type: 'heard', text, sttConfidence: deps.sttConfidence(text) });
      return true;
    },
    confirmYes() {
      if (receptionState !== SCREEN || capture.phase !== 'readback') return false;
      apply({ type: 'answer', yes: true });
      return true;
    },
    confirmNo() {
      if (receptionState !== SCREEN || capture.phase !== 'readback') return false;
      apply({ type: 'answer', yes: false });
      return true;
    },
  };
}
