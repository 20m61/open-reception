import { describe, expect, it, vi } from 'vitest';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import { VISITOR_NAME_ANSWER_TIMEOUT_MS } from '@/domain/voice-session/visitor-name-capture';
import { createVisitorNameRouter, type VisitorNameTimer } from './visitor-name-router';

/**
 * 音声セッションの結線で、確定した発話を「氏名の聞き取り」へ回す層 (#1290)。合成データだけを使う。
 */
function fakeTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  const timer: VisitorNameTimer = (fn, ms) => {
    pending = { fn, ms };
    return () => {
      pending = null;
    };
  };
  return {
    timer,
    get pendingMs() {
      return pending?.ms ?? null;
    },
    fire() {
      const p = pending;
      pending = null;
      p?.fn();
    },
  };
}

function setup() {
  const events: VoiceKioskEvent[] = [];
  const confirmed: string[] = [];
  const resetTurn = vi.fn();
  const timer = fakeTimer();
  const router = createVisitorNameRouter({
    emit: (e) => events.push(e),
    onVisitorNameConfirmed: (name) => confirmed.push(name),
    sttConfidence: () => 0.9,
    resetTurn,
    timer: timer.timer,
  });
  return { router, events, confirmed, resetTurn, timer };
}

function onScreen(router: ReturnType<typeof setup>['router']) {
  router.notifyReceptionState('inputVisitorInfo');
  router.visitorName({ type: 'enter', eligible: true });
  router.visitorName({ type: 'noticeFinished', ok: true });
}

describe('createVisitorNameRouter', () => {
  it('inputVisitorInfo 以外の発話は受け取らない（相手の解決へ回る）', () => {
    const { router, events } = setup();
    for (const state of ['idle', 'selectingPurpose', 'selectingTarget', 'confirming', 'calling'] as const) {
      router.notifyReceptionState(state);
      expect(router.takeTurn('受付です'), state).toBe(false);
      expect(router.confirmYes(), state).toBe(false);
      expect(router.confirmNo(), state).toBe(false);
    }
    expect(events).toEqual([]);
  });

  it('inputVisitorInfo では、通知の前でも発話を受け取る（相手の解決へ回さない）が、氏名には使わない', () => {
    const { router, events, confirmed } = setup();
    router.notifyReceptionState('inputVisitorInfo');
    router.visitorName({ type: 'enter', eligible: true });
    expect(router.takeTurn('受付です')).toBe(true);
    expect(events).toEqual([]);
    expect(confirmed).toEqual([]);
  });

  it('通知を読み終えたら尋ね、名乗りを復唱し、「はい」で onVisitorNameConfirmed を 1 回だけ呼ぶ', () => {
    const { router, events, confirmed } = setup();
    onScreen(router);
    router.takeTurn('受付 太郎です');
    router.takeTurn('はい');
    router.confirmYes();
    expect(events).toEqual([
      { type: 'visitorNameAsk', retry: false },
      { type: 'visitorNameReadback', name: '受付 太郎' },
      { type: 'confirmYes' },
    ]);
    expect(confirmed).toEqual(['受付 太郎']);
  });

  it('ボタンの「はい／いいえ」は復唱中だけ氏名の答えになる', () => {
    const { router, confirmed, events } = setup();
    onScreen(router);
    expect(router.confirmYes()).toBe(false);
    router.takeTurn('受付です');
    expect(router.confirmNo()).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'visitorNameAsk', retry: true });
    router.takeTurn('受付です');
    expect(router.confirmYes()).toBe(true);
    expect(confirmed).toEqual(['受付']);
  });

  it('発話ごとにターンを区切る（次の発話を受けられるように）', () => {
    const { router, resetTurn } = setup();
    onScreen(router);
    router.takeTurn('受付です');
    expect(resetTurn).toHaveBeenCalledTimes(1);
  });

  it('名乗り・答えを待つ時間が過ぎたら 1 回の失敗。3 回でキーボードへ案内する', () => {
    const { router, events, timer } = setup();
    onScreen(router);
    expect(timer.pendingMs).toBe(VISITOR_NAME_ANSWER_TIMEOUT_MS);
    timer.fire();
    timer.fire();
    timer.fire();
    expect(events.slice(1)).toEqual([
      { type: 'visitorNameAsk', retry: true },
      { type: 'visitorNameAsk', retry: true },
      { type: 'visitorNameKeyboard' },
    ]);
    expect(timer.pendingMs).toBeNull();
  });

  it('復唱への答えを待つ時間も測る。過ぎたら退けたものとして聞き直す (#1290 の独立レビュー m-5)', () => {
    const { router, events, confirmed, timer } = setup();
    onScreen(router);
    router.takeTurn('受付 太郎です');
    expect(events.at(-1)).toEqual({ type: 'visitorNameReadback', name: '受付 太郎' });
    expect(timer.pendingMs).toBe(VISITOR_NAME_ANSWER_TIMEOUT_MS);
    timer.fire();
    expect(events.at(-1)).toEqual({ type: 'visitorNameAsk', retry: true });
    expect(confirmed).toEqual([]);
  });

  it('通知を読み上げてよいのは、enter が聞き取りを始めたときだけ (#1290 の独立レビュー M-A)', () => {
    const { router } = setup();
    router.notifyReceptionState('inputVisitorInfo');
    expect(router.visitorName({ type: 'enter', eligible: true })).toBe(true);
    // 同じ画面での再送（言語の切り替え等）は、どの局面でも始めない。
    expect(router.visitorName({ type: 'enter', eligible: true })).toBe(false);
    router.visitorName({ type: 'noticeFinished', ok: true });
    expect(router.visitorName({ type: 'enter', eligible: true })).toBe(false);
    router.takeTurn('受付 太郎です');
    expect(router.visitorName({ type: 'enter', eligible: true })).toBe(false);
    // 聞けない画面の enter は始めない。
    router.notifyReceptionState('confirming');
    router.notifyReceptionState('inputVisitorInfo');
    expect(router.visitorName({ type: 'enter', eligible: false })).toBe(false);
    // 下界: 画面を出て入り直したら、また始める。
    router.notifyReceptionState('confirming');
    router.notifyReceptionState('inputVisitorInfo');
    expect(router.visitorName({ type: 'enter', eligible: true })).toBe(true);
  });

  it('何も変えない入力では、答えを待つ時間を測り直さない (#1290 の独立レビュー MINOR-1)', () => {
    const arms: number[] = [];
    let pending: (() => void) | null = null;
    const router = createVisitorNameRouter({
      emit: () => {},
      onVisitorNameConfirmed: () => {},
      sttConfidence: () => 0.9,
      resetTurn: () => {},
      timer: (fn, ms) => {
        arms.push(ms);
        pending = fn;
        return () => {
          pending = null;
        };
      },
    });
    onScreen(router);
    router.takeTurn('受付 太郎です');
    expect(arms).toHaveLength(2); // 尋ねる・復唱
    router.visitorName({ type: 'enter', eligible: true });
    router.visitorName({ type: 'noticeFinished', ok: true });
    expect(arms).toHaveLength(2);
    expect(pending).not.toBeNull();
  });

  it('打ち始めたら畳み、待ち時間も止める', () => {
    const { router, events, timer } = setup();
    onScreen(router);
    router.takeTurn('受付です');
    router.visitorName({ type: 'typing' });
    expect(events.at(-1)).toEqual({ type: 'visitorNameStopped' });
    expect(timer.pendingMs).toBeNull();
  });

  it('画面を出たら畳み、ターンを捨て、待ち時間を止める。遅れて届いた発話・答えは使わない', () => {
    const { router, events, confirmed, resetTurn, timer } = setup();
    onScreen(router);
    router.takeTurn('受付です');
    resetTurn.mockClear();
    router.notifyReceptionState('idle');
    expect(events.at(-1)).toEqual({ type: 'visitorNameStopped' });
    expect(resetTurn).toHaveBeenCalledTimes(1);
    expect(timer.pendingMs).toBeNull();
    expect(router.takeTurn('はい')).toBe(false);
    expect(router.confirmYes()).toBe(false);
    expect(confirmed).toEqual([]);
  });

  it('同じ画面に戻っても、enter を受けるまでは何も始めない（前の回数・候補を持ち越さない）', () => {
    const { router, events, confirmed } = setup();
    onScreen(router);
    router.takeTurn('受付です');
    router.notifyReceptionState('confirming');
    const before = events.length;
    router.notifyReceptionState('inputVisitorInfo');
    router.takeTurn('はい');
    expect(router.confirmYes()).toBe(false);
    expect(events.length).toBe(before);
    expect(confirmed).toEqual([]);
  });

  it('STT の確信度は発話ごとに結線の値を使う（下限未満は失敗）', () => {
    const events: VoiceKioskEvent[] = [];
    const router = createVisitorNameRouter({
      emit: (e) => events.push(e),
      onVisitorNameConfirmed: () => {},
      sttConfidence: (text) => (text.includes('受付') ? 0.3 : 0.9),
      resetTurn: () => {},
      timer: fakeTimer().timer,
    });
    onScreen(router);
    router.takeTurn('受付です');
    expect(events.at(-1)).toEqual({ type: 'visitorNameAsk', retry: true });
  });
});
