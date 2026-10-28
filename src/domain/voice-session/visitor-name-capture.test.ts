import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_RESOLUTION_THRESHOLDS } from '@/domain/voice-stt/entity-resolver';
import { DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY } from '@/domain/reception/slot-proposal';
import { VISITOR_NAME_MAX_LENGTH } from '@/domain/reception/session';
import {
  VISITOR_NAME_MAX_ATTEMPTS,
  initialVisitorNameCapture,
  stepVisitorNameCapture,
  type VisitorNameCapture,
  type VisitorNameCaptureEffect,
  type VisitorNameCaptureEvent,
} from './visitor-name-capture';

/**
 * 音声で来訪者の氏名を聞き取る段の状態機械（ADR 0011 §2・§3、#1290）。合成データだけを使う。
 *
 * 縛る不変条件:
 * - 氏名を確定（`confirmed` の効果）するのは、復唱への「はい」（声かボタン）の直後だけ。
 * - 通知を正常に読み終える前の発話は、氏名に使わない。
 * - 失敗は最大 3 回（最初の質問 + 言い直し 2 回）。尽きたらキーボードへ移り、同じ画面では戻らない。
 * - 打ち始めたら、以後この画面では聞き取りも復唱もしない。
 * - 画面を出たら、候補も回数も捨てる。
 */
const STT_OK = 0.9;
const STT_LOW = DEFAULT_ENTITY_RESOLUTION_THRESHOLDS.minSttConfidence - 0.01;

function run(events: readonly VisitorNameCaptureEvent[], from: VisitorNameCapture = initialVisitorNameCapture()) {
  let state = from;
  const effects: VisitorNameCaptureEffect[] = [];
  for (const event of events) {
    const step = stepVisitorNameCapture(state, event);
    state = step.state;
    if (step.effect) effects.push(step.effect);
  }
  return { state, effects };
}

const ENTER: VisitorNameCaptureEvent = { type: 'enter', eligible: true };
const NOTICE_OK: VisitorNameCaptureEvent = { type: 'noticeFinished', ok: true };
const heard = (text: string, sttConfidence = STT_OK): VisitorNameCaptureEvent => ({ type: 'heard', text, sttConfidence });
const READY = [ENTER, NOTICE_OK];

const confirmedNames = (effects: readonly VisitorNameCaptureEffect[]) =>
  effects.flatMap((e) => (e.kind === 'confirmed' ? [e.name] : []));

describe('通知を読み終えてから聞く（§2）', () => {
  it('通知を正常に読み終えたら聞き取りを始める', () => {
    const { state, effects } = run(READY);
    expect(state.phase).toBe('asking');
    expect(effects).toEqual([{ kind: 'listen' }]);
  });

  it('通知の読み上げ中の発話は、氏名にも復唱にも使わない', () => {
    const { state, effects } = run([ENTER, heard('受付 太郎です'), NOTICE_OK]);
    expect(state.phase).toBe('asking');
    expect(effects).toEqual([{ kind: 'listen' }]);
  });

  it('通知が失敗・時間切れなら、音声で聞かない（キーボードだけ）', () => {
    const { state, effects } = run([ENTER, { type: 'noticeFinished', ok: false }, heard('受付です')]);
    expect(state).toEqual({ phase: 'keyboard', reason: 'noticeFailed' });
    expect(effects).toEqual([]);
  });

  it('対象外（TTS が使えない・確認から戻った・氏名の欄が無い 等）なら、何を聞いても使わない', () => {
    const { state, effects } = run([
      { type: 'enter', eligible: false },
      NOTICE_OK,
      heard('受付です'),
      { type: 'answer', yes: true },
    ]);
    expect(state.phase).toBe('keyboard');
    expect(effects).toEqual([]);
  });

  it('画面に入る前（off）の発話は使わない', () => {
    const { state, effects } = run([heard('受付です'), { type: 'answer', yes: true }]);
    expect(state.phase).toBe('off');
    expect(effects).toEqual([]);
  });
});

describe('必ず復唱し、「はい」のときだけ確定する（§3-b）', () => {
  it('確信度が高くても、まず復唱する', () => {
    const { state, effects } = run([...READY, heard('受付 太郎です')]);
    expect(state.phase).toBe('readback');
    expect(effects.at(-1)).toEqual({ kind: 'readback', name: '受付 太郎' });
    expect(confirmedNames(effects)).toEqual([]);
  });

  it('声の「はい」で確定する', () => {
    const { state, effects } = run([...READY, heard('受付 太郎です'), heard('はい')]);
    expect(state.phase).toBe('confirmed');
    expect(confirmedNames(effects)).toEqual(['受付 太郎']);
  });

  it('ボタンの「はい」で確定する（音声とタッチの等価）', () => {
    const { effects } = run([...READY, heard('受付 太郎です'), { type: 'answer', yes: true }]);
    expect(confirmedNames(effects)).toEqual(['受付 太郎']);
  });

  it('確定は 1 回だけ。確定後の発話・ボタンは何もしない', () => {
    const { state, effects } = run([
      ...READY,
      heard('受付 太郎です'),
      heard('はい'),
      heard('はい'),
      { type: 'answer', yes: true },
      heard('別人です'),
    ]);
    expect(state.phase).toBe('confirmed');
    expect(confirmedNames(effects)).toEqual(['受付 太郎']);
  });

  it('復唱の名前は前後のゼロ幅文字を含まない', () => {
    const { effects } = run([...READY, heard('​受付​'), heard('はい')]);
    expect(confirmedNames(effects)).toEqual(['受付']);
  });

  it('不変条件: どの順序のイベント列でも、confirmed の直前の入力は「はい」（声・ボタン）', () => {
    // 有限の語彙での総当たり（長さ 4 まで）。確定の効果が出たら、その入力が肯定であることを縛る。
    const vocabulary: VisitorNameCaptureEvent[] = [
      ENTER,
      NOTICE_OK,
      { type: 'noticeFinished', ok: false },
      heard('受付です'),
      heard('はい'),
      heard('いいえ'),
      heard('はい', STT_LOW),
      { type: 'answer', yes: true },
      { type: 'answer', yes: false },
      { type: 'noAnswer' },
      { type: 'typing' },
      { type: 'leave' },
    ];
    const isAffirmative = (e: VisitorNameCaptureEvent) =>
      (e.type === 'answer' && e.yes) || (e.type === 'heard' && e.text === 'はい' && e.sttConfidence >= STT_OK);
    let confirmations = 0;
    const walk = (state: VisitorNameCapture, depth: number) => {
      if (depth === 0) return;
      for (const event of vocabulary) {
        const step = stepVisitorNameCapture(state, event);
        if (step.effect?.kind === 'confirmed') {
          confirmations += 1;
          expect(isAffirmative(event), JSON.stringify(event)).toBe(true);
          expect(state.phase).toBe('readback');
        }
        walk(step.state, depth - 1);
      }
    };
    walk(initialVisitorNameCapture(), 5);
    // 下界: 確定に至る列が存在する（全部を判定不能にして空虚に満たしていない）。
    expect(confirmations).toBeGreaterThan(0);
  });
});

describe('聞き違いへの対策（§3-a・§3-c・§3-e）', () => {
  it('STT の確信度が下限未満の名乗りは、候補にせず 1 回の失敗と数える', () => {
    const { state, effects } = run([...READY, heard('受付です', STT_LOW)]);
    expect(state).toMatchObject({ phase: 'asking', failures: 1 });
    expect(effects.at(-1)).toEqual({ kind: 'askAgain' });
  });

  it('下限ちょうどの STT は候補にする（境界の内側）', () => {
    const { state } = run([
      ...READY,
      heard('受付です', DEFAULT_ENTITY_RESOLUTION_THRESHOLDS.minSttConfidence),
    ]);
    expect(state.phase).toBe('readback');
  });

  it('抽出器の確信度が下限未満（名乗りではない発話）は失敗と数える', () => {
    expect(DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY.minProposalConfidence).toBeGreaterThan(0.3);
    const { state } = run([...READY, heard('田中さんに会いに来ました')]);
    expect(state).toMatchObject({ phase: 'asking', failures: 1 });
  });

  it('上限を超える氏名は候補にしない（ちょうど上限は候補にする）', () => {
    const atLimit = run([...READY, heard('あ'.repeat(VISITOR_NAME_MAX_LENGTH))]);
    expect(atLimit.state.phase).toBe('readback');
    const over = run([...READY, heard('あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1))]);
    expect(over.state).toMatchObject({ phase: 'asking', failures: 1 });
  });

  it('復唱への声の答えは STT の下限を課す。下限未満の「はい」は確定せず、氏名から聞き直す', () => {
    const { state, effects } = run([...READY, heard('受付です'), heard('はい', STT_LOW)]);
    expect(confirmedNames(effects)).toEqual([]);
    expect(state).toMatchObject({ phase: 'asking', failures: 1 });
    expect(effects.at(-1)).toEqual({ kind: 'askAgain' });
  });

  it('「いいえ」（声・ボタン）は失敗と数え、氏名から聞き直す。前の候補は残さない', () => {
    for (const no of [heard('いいえ'), { type: 'answer', yes: false } as const]) {
      const { state, effects } = run([...READY, heard('受付です'), no, heard('はい')]);
      // 「いいえ」の後の「はい」で、退けた候補が確定しない（asking での「はい」は名乗りでもないので 2 回目の失敗）。
      expect(confirmedNames(effects), JSON.stringify(no)).toEqual([]);
      expect(state).toMatchObject({ phase: 'asking', failures: 2 });
    }
  });

  it('どちらでもない答え・無応答も失敗と数える', () => {
    expect(run([...READY, heard('受付です'), heard('えっと')]).state).toMatchObject({ failures: 1 });
    expect(run([...READY, heard('受付です'), { type: 'noAnswer' }]).state).toMatchObject({ failures: 1 });
    expect(run([...READY, { type: 'noAnswer' }]).state).toMatchObject({ failures: 1 });
  });

  it('言い直しで正しく聞き取れれば、そちらを確定する', () => {
    const { effects } = run([...READY, heard('受付です'), heard('いいえ'), heard('受付 花子です'), heard('はい')]);
    expect(confirmedNames(effects)).toEqual(['受付 花子']);
  });

  it(`失敗が ${VISITOR_NAME_MAX_ATTEMPTS} 回でキーボードへ移り、同じ画面では音声に戻らない`, () => {
    expect(VISITOR_NAME_MAX_ATTEMPTS).toBe(3);
    const twice = run([...READY, { type: 'noAnswer' }, { type: 'noAnswer' }]);
    expect(twice.state).toMatchObject({ phase: 'asking', failures: 2 });
    const { state, effects } = run([
      ...READY,
      { type: 'noAnswer' },
      { type: 'noAnswer' },
      { type: 'noAnswer' },
      heard('受付です'),
      { type: 'answer', yes: true },
    ]);
    expect(state).toEqual({ phase: 'keyboard', reason: 'exhausted' });
    expect(effects.filter((e) => e.kind === 'keyboard')).toHaveLength(1);
    expect(effects.at(-1)).toEqual({ kind: 'keyboard' });
    expect(confirmedNames(effects)).toEqual([]);
  });

  it('失敗の数え方は種類を問わず累計（いいえ・下限未満・無応答の混在で 3 回）', () => {
    const { state } = run([
      ...READY,
      heard('受付です'),
      heard('いいえ'),
      heard('受付です', STT_LOW),
      heard('受付です'),
      { type: 'noAnswer' },
    ]);
    expect(state).toEqual({ phase: 'keyboard', reason: 'exhausted' });
  });
});

describe('キーボードとの関係（§3-c・§4）', () => {
  it('打ち始めたら、聞き取りも復唱も止める（以後の発話・ボタンは使わない）', () => {
    for (const before of [[ENTER], [...READY], [...READY, heard('受付です')]]) {
      const { state, effects } = run([...before, { type: 'typing' }, NOTICE_OK, heard('受付です'), heard('はい')]);
      expect(state, JSON.stringify(before)).toEqual({ phase: 'keyboard', reason: 'typing' });
      expect(confirmedNames(effects)).toEqual([]);
    }
  });

  it('復唱の途中で打ち始めたら、止めたことを UI へ伝える', () => {
    const { effects } = run([...READY, heard('受付です'), { type: 'typing' }]);
    expect(effects.at(-1)).toEqual({ kind: 'stopped' });
  });
});

describe('画面を出たら捨てる（§3-c・§6）', () => {
  it('leave で候補も回数も捨てる。再入場は数え直す', () => {
    const left = run([...READY, heard('受付です'), heard('いいえ'), { type: 'leave' }]);
    expect(left.state).toEqual({ phase: 'off' });
    const again = run([ENTER, NOTICE_OK, { type: 'noAnswer' }], left.state);
    expect(again.state).toMatchObject({ phase: 'asking', failures: 1 });
  });

  it('leave の後に遅れて届いた発話・答えは使わない（前の来訪者の発話を次へ持ち越さない）', () => {
    const { state, effects } = run([...READY, heard('受付です'), { type: 'leave' }, heard('はい'), { type: 'answer', yes: true }]);
    expect(state).toEqual({ phase: 'off' });
    expect(confirmedNames(effects)).toEqual([]);
  });

  it('再入場しても、通知を読み終えるまでは前の候補も新しい発話も使わない', () => {
    const { effects } = run([...READY, heard('受付です'), { type: 'leave' }, ENTER, heard('はい'), { type: 'answer', yes: true }]);
    expect(confirmedNames(effects)).toEqual([]);
  });

  it('状態は氏名を外へ持ち出す形を持たない（readback 以外に名前を置かない）', () => {
    const { state } = run([...READY, heard('受付です'), heard('はい')]);
    expect(JSON.stringify(state)).not.toContain('受付');
  });
});
