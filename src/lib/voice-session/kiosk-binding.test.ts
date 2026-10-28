import { describe, expect, it, vi } from 'vitest';
import { createSyntheticVoiceSession, createOrchestratorVoiceSession, type VoiceSessionLike } from './kiosk-binding';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import type { VoiceSessionCallbacks } from './orchestrator';
import type { Staff } from '@/domain/staff/types';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';

function staff(id: string, displayName: string, kana: string): Staff {
  return {
    id, displayName, kana, aliases: [], departmentId: 'd1',
    enabled: true, available: true, callTargets: [], fallbackStaffIds: [],
  };
}

const directory = {
  staff: [staff('s1', '佐藤', 'さとう'), staff('s2', '鈴木', 'すずき')],
  departments: [{ id: 'd1', name: '総務部', kana: 'そうむぶ', displayOrder: 0, enabled: true }],
};

/** emit を集めるヘルパ。 */
function collector() {
  const events: VoiceKioskEvent[] = [];
  return { emit: (e: VoiceKioskEvent) => events.push(e), events };
}

describe('createSyntheticVoiceSession (#364 mock synthetic 駆動 / demo-studio 再現用)', () => {
  it('高信頼発話は heardAccepted を emit する', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95 });
    driver.factory(emit);
    driver.beginListening();
    driver.hearTurn('さとう');
    expect(events).toContainEqual({ type: 'listenStart' });
    expect(events).toContainEqual({ type: 'heardAccepted' });
  });

  it('低信頼発話は復唱確認（heardNeedsConfirmation）を emit し、confirmYes/No が確定/聞き直しを emit する', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.3 });
    const controller = driver.factory(emit);
    driver.beginListening();
    driver.hearTurn('さとう');
    expect(events).toContainEqual({
      type: 'heardNeedsConfirmation',
      displayName: '佐藤',
      reason: 'low_stt_confidence',
      // 復唱テンプレート出し分け用の種別 (issue #361 申し送り)。staff 解決は 'staff'。
      kind: 'staff',
    });

    controller.confirmYes();
    expect(events).toContainEqual({ type: 'confirmYes' });

    // 別セッションで No 経路
    const c2 = collector();
    const d2 = createSyntheticVoiceSession({ directory, sttConfidence: 0.3 });
    const ctrl2 = d2.factory(c2.emit);
    d2.hearTurn('さとう');
    ctrl2.confirmNo();
    expect(c2.events).toContainEqual({ type: 'confirmNo' });
  });

  it('barge-in と障害を emit する（TTS 割込・タッチ縮退）', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory });
    driver.factory(emit);
    driver.startSpeaking();
    driver.bargeIn();
    driver.beginListening();
    expect(events).toEqual([
      { type: 'speakStart' },
      { type: 'bargeInDuck' },
      { type: 'listenStart' },
    ]);

    const c2 = collector();
    const d2 = createSyntheticVoiceSession({ directory });
    d2.factory(c2.emit);
    d2.fail('stt');
    expect(c2.events).toContainEqual({ type: 'fallbackRequired', source: 'stt' });
  });

  it('確定コールバック(onResolved)へ解決済み候補を渡す（既存選択への橋渡し）', () => {
    const onResolved = vi.fn();
    const { emit } = collector();
    const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95, onResolved });
    driver.factory(emit);
    driver.hearTurn('さとう');
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('hearPartial は確定前 interim を逐次 emit する（#361/#364 第11wave 逐次字幕）', () => {
    const { emit, events } = collector();
    const driver = createSyntheticVoiceSession({ directory });
    driver.factory(emit);
    driver.beginListening();
    driver.hearPartial('さ');
    driver.hearPartial('さとう');
    expect(events).toEqual([
      { type: 'listenStart' },
      { type: 'hearPartial', text: 'さ' },
      { type: 'hearPartial', text: 'さとう' },
    ]);
  });
});

describe('createOrchestratorVoiceSession (実 orchestrator を束ねる seam・fake で検証)', () => {
  function fakeOrchestrator() {
    const calls: string[] = [];
    let captured: VoiceSessionCallbacks | null = null;
    const like: VoiceSessionLike = {
      start: () => { calls.push('start'); },
      close: () => { calls.push('close'); },
      resetTurn: () => { calls.push('resetTurn'); },
    };
    const construct = (cb: VoiceSessionCallbacks) => { captured = cb; return like; };
    return { construct, calls, getCallbacks: () => captured };
  }

  it('onTurnCommitted を Entity 解決経由で UI イベントへ写像し、高信頼は heardAccepted + onResolved', () => {
    const onResolved = vi.fn();
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.95, onResolved });
    factory(emit);
    fake.getCallbacks()!.onTurnCommitted!('さとう', 'silence');
    expect(events).toContainEqual({ type: 'heardAccepted' });
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('低信頼の onTurnCommitted は復唱確認を emit し、confirmYes で resetTurn + onResolved する', () => {
    const onResolved = vi.fn();
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.3, onResolved });
    const controller = factory(emit);
    fake.getCallbacks()!.onTurnCommitted!('さとう', 'silence');
    expect(events).toContainEqual(expect.objectContaining({ type: 'heardNeedsConfirmation', displayName: '佐藤' }));

    controller.confirmYes();
    expect(events).toContainEqual({ type: 'confirmYes' });
    expect(fake.calls).toContain('resetTurn');
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('onVrmStateChange を speakStart/speakEnd へ、非 TTS 由来の onFallback を fallbackRequired へ写像する', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    const cb = fake.getCallbacks()!;
    cb.onVrmStateChange!('speaking');
    cb.onVrmStateChange!('listening');
    expect(events).toContainEqual({ type: 'speakStart' });
    expect(events).toContainEqual({ type: 'speakEnd' });

    cb.onFallback!({ type: 'voiceSessionFallbackRequired', source: 'transport', reason: 'x', t: 1 });
    expect(events).toContainEqual({ type: 'fallbackRequired', source: 'transport' });
  });

  it('TTS 由来の onFallback はタッチ強制切替にしない（継続可能なので fallbackRequired を emit しない）', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    fake.getCallbacks()!.onFallback!({ type: 'voiceSessionFallbackRequired', source: 'tts', reason: 'caption_only', t: 2 });
    expect(events.some((e) => e.type === 'fallbackRequired')).toBe(false);
  });

  it('start/close を配下 orchestrator へ委譲する', () => {
    const fake = fakeOrchestrator();
    const { emit } = collector();
    const controller = createOrchestratorVoiceSession(fake.construct, { directory })(emit);
    void controller.start();
    void controller.close();
    expect(fake.calls).toContain('start');
    expect(fake.calls).toContain('close');
  });

  it('受付局面の通知だけでは何も起きない（相手の解決・発話の開始へ影響しない）', () => {
    // 以前は「notifyReceptionState を実装しない」で縛っていた。氏名の聞き取り (#1290) が画面の出入りを
    // 知るために実装するようになったので、守りたかった性質（通知で発話や確定が起きない）を直接縛る。
    const onResolved = vi.fn();
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const controller = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.95 })(emit, {
      onResolved,
    });
    for (const state of ['idle', 'selectingPurpose', 'selectingTarget', 'inputVisitorInfo', 'confirming', 'idle'] as const) {
      controller.notifyReceptionState?.(state);
    }
    expect(events).toEqual([]);
    expect(onResolved).not.toHaveBeenCalled();
    expect(fake.calls.filter((c) => c !== 'resetTurn')).toEqual([]);
  });

  describe('氏名の聞き取り (ADR 0011、#1290)', () => {
    function onNameScreen(controller: ReturnType<ReturnType<typeof createOrchestratorVoiceSession>>) {
      controller.notifyReceptionState?.('inputVisitorInfo');
      controller.visitorName?.({ type: 'enter', eligible: true });
      controller.visitorName?.({ type: 'noticeFinished', ok: true });
    }

    it('inputVisitorInfo の発話は相手の解決へ回らず、復唱 → 「はい」で onVisitorNameConfirmed だけを呼ぶ', () => {
      const onResolved = vi.fn();
      const onVisitorNameConfirmed = vi.fn();
      const fake = fakeOrchestrator();
      const { emit, events } = collector();
      const controller = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.95 })(emit, {
        onResolved,
        onVisitorNameConfirmed,
      });
      onNameScreen(controller);
      // 担当者名と同じ発話でも、この画面では氏名の候補として扱う（SELECT_TARGET を起こさない）。
      fake.getCallbacks()!.onTurnCommitted!('佐藤です', 'silence');
      expect(events.at(-1)).toEqual({ type: 'visitorNameReadback', name: '佐藤' });
      fake.getCallbacks()!.onTurnCommitted!('はい', 'silence');
      expect(onVisitorNameConfirmed).toHaveBeenCalledExactlyOnceWith('佐藤');
      expect(onResolved).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'heardAccepted' || e.type === 'heardNeedsConfirmation')).toBe(false);
      // 発話ごとにターンを区切る。
      expect(fake.calls.filter((c) => c === 'resetTurn')).toHaveLength(2);
    });

    it('ボタンの「はい」も同じ入口（音声とタッチの等価）。復唱中でなければ相手の復唱の答えとして扱う', () => {
      const onVisitorNameConfirmed = vi.fn();
      const onResolved = vi.fn();
      const fake = fakeOrchestrator();
      const { emit } = collector();
      const controller = createOrchestratorVoiceSession(fake.construct, { directory, sttConfidence: 0.95 })(emit, {
        onResolved,
        onVisitorNameConfirmed,
      });
      onNameScreen(controller);
      fake.getCallbacks()!.onTurnCommitted!('受付です', 'silence');
      controller.confirmYes();
      expect(onVisitorNameConfirmed).toHaveBeenCalledExactlyOnceWith('受付');
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('構築時の deps.onResolved は氏名の確定に使わない（hooks の onVisitorNameConfirmed だけ）', () => {
      const onResolved = vi.fn();
      const fake = fakeOrchestrator();
      const { emit } = collector();
      const controller = createOrchestratorVoiceSession(fake.construct, {
        directory,
        sttConfidence: 0.95,
        onResolved,
      })(emit);
      onNameScreen(controller);
      fake.getCallbacks()!.onTurnCommitted!('受付です', 'silence');
      fake.getCallbacks()!.onTurnCommitted!('はい', 'silence');
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('画面を出たら途中のターンを捨てる', () => {
      const fake = fakeOrchestrator();
      const { emit } = collector();
      const controller = createOrchestratorVoiceSession(fake.construct, { directory })(emit);
      onNameScreen(controller);
      fake.calls.length = 0;
      controller.notifyReceptionState?.('idle');
      expect(fake.calls).toEqual(['resetTurn']);
    });

    it('synthetic 経路も同じ（demo-studio 再現）', () => {
      const onVisitorNameConfirmed = vi.fn();
      const { emit, events } = collector();
      const driver = createSyntheticVoiceSession({ directory, sttConfidence: 0.95 });
      const controller = driver.factory(emit, { onVisitorNameConfirmed });
      controller.notifyReceptionState?.('inputVisitorInfo');
      controller.visitorName?.({ type: 'enter', eligible: true });
      controller.visitorName?.({ type: 'noticeFinished', ok: true });
      driver.hearTurn('受付 花子です');
      expect(events.at(-1)).toEqual({ type: 'visitorNameReadback', name: '受付 花子' });
      controller.confirmYes();
      expect(onVisitorNameConfirmed).toHaveBeenCalledExactlyOnceWith('受付 花子');
    });
  });

  it('onEvalEvent の stt.partial(stable) を interim(hearPartial) へ写像する（#361/#364 第11wave 実経路結線）', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    const cb = fake.getCallbacks()!;
    // 安定化前（stable:false）の先読み partial は UI へ出さない（#370 ちらつき抑制方針）。
    cb.onEvalEvent!({ type: 'stt.partial', t: 1, turnIndex: 0, text: 'さ', stable: false });
    expect(events.some((e) => e.type === 'hearPartial')).toBe(false);
    // 安定化済み（stable:true）は interim 字幕として逐次反映する。
    cb.onEvalEvent!({ type: 'stt.partial', t: 2, turnIndex: 0, text: 'さとう', stable: true });
    expect(events).toContainEqual({ type: 'hearPartial', text: 'さとう' });
  });

  it('onEvalEvent の stt.partial 以外（stt.final 等）は interim へ写像しない（表示専用の逐次字幕のみ）', () => {
    const fake = fakeOrchestrator();
    const { emit, events } = collector();
    const factory = createOrchestratorVoiceSession(fake.construct, { directory });
    factory(emit);
    fake.getCallbacks()!.onEvalEvent!({ type: 'stt.final', t: 3, turnIndex: 0, text: 'さとう' });
    expect(events.some((e) => e.type === 'hearPartial')).toBe(false);
  });
});

/**
 * 不在辞書が bridge まで届くこと (#803)。
 *
 * 🔴 **振る舞いで縛る。** 転送の 1 行を消す変異は、これを書くまで全緑で生き残った
 * （独立レビューの実測）。型は任意引数なので、消しても誰も困らない形に見えてしまう。
 */
describe('不在辞書の転送 (#803)', () => {
  const PRESENT: EntityDirectory = {
    staff: [
      {
        id: 'in',
        displayName: '在席太郎',
        kana: 'ざいせきたろう',
        aliases: [],
        departmentId: 'd1',
        enabled: true,
        available: true,
        callTargets: [],
        fallbackStaffIds: [],
      },
    ],
    departments: [],
  };
  const ABSENT: EntityDirectory = {
    staff: [
      {
        id: 'out',
        displayName: '不在花子',
        kana: 'ふざいはなこ',
        aliases: [],
        departmentId: 'd1',
        enabled: true,
        available: true,
        callTargets: [],
        fallbackStaffIds: [],
      },
    ],
    departments: [],
  };

  function eventsFor(deps: Parameters<typeof createSyntheticVoiceSession>[0], text: string) {
    const emitted: VoiceKioskEvent[] = [];
    const driver = createSyntheticVoiceSession(deps);
    driver.factory((e) => emitted.push(e));
    driver.beginListening();
    driver.hearTurn(text);
    return emitted;
  }

  it('渡せば不在の相手を認識する', () => {
    const events = eventsFor(
      { directory: PRESENT, unavailableDirectory: ABSENT, sttConfidence: 0.95 },
      '不在花子',
    );
    expect(events.some((e) => e.type === 'heardUnavailable')).toBe(true);
  });

  /** 🔴 **下界。** 「常に heardUnavailable を出す」実装で上のテストを満たさせない。 */
  it('渡さなければ従来どおり聞き直しになる', () => {
    const events = eventsFor({ directory: PRESENT, sttConfidence: 0.95 }, '不在花子');
    expect(events.some((e) => e.type === 'heardUnavailable')).toBe(false);
  });
});
