/**
 * 音声セッションが受付状態機械へ触れる面を固定する (ADR 0007 / ADR 0011 §1)。
 *
 * **発信前の確認ゲートを音声が迂回できない**ことの実際の保証は、`VoiceSessionHooks` が
 * 公開する口が限られていて、それぞれが起こせる受付イベントも限られていることである。
 * `REQUIRES_CONFIRMATION_ACTIONS` はチャット経路と宣言値にしか使われておらず、音声を止めていない
 * （ADR 0007 のレビューで判明）。
 *
 * ADR 0011 で口を 1 つ足した（`onVisitorNameConfirmed` → `SUBMIT_VISITOR_INFO`）。1 つの一覧へ
 * 足すだけにすると、新しいハンドラが検査の範囲から漏れる。**ハンドラごとに**起こせるイベントを縛り、
 * `VoiceSessionLayer` へ渡す `on*` のハンドラが全部この表に載っていることも縛る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const KIOSK_FLOW = 'src/components/kiosk/KioskFlow.tsx';

/** 口（hook）→ KioskFlow のハンドラ → 起こしてよい受付イベント。 */
const ALLOWED: Record<string, { handler: string; events: readonly string[] }> = {
  onResolved: { handler: 'handleVoiceResolved', events: ['SELECT_TARGET'] },
  onVisitorNameConfirmed: { handler: 'handleVoiceNameConfirmed', events: ['SUBMIT_VISITOR_INFO'] },
};

/** `const <name> = useCallback...(` から、その useCallback の依存配列の閉じ（`]);`）までを返す。 */
function handlerBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback`);
  expect(start, `${name} が見つからない`).toBeGreaterThanOrEqual(0);
  const deps = source.indexOf('}, [', start);
  expect(deps, `${name} の依存配列が見つからない`).toBeGreaterThan(start);
  return source.slice(start, source.indexOf(']);', deps));
}

function dispatchedEvents(body: string): string[] {
  return [...body.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1] ?? '');
}

describe('音声セッションの露出面 (ADR 0007 / ADR 0011 §1)', () => {
  it('VoiceSessionHooks が公開するのは onResolved と onVisitorNameConfirmed だけ', () => {
    // 型の形をソースで固定する（実行時に型は消えるため、静的検査で押さえる）。
    const source = readFileSync('src/lib/voice-session/kiosk-binding.ts', 'utf8');
    const match = source.match(/export type VoiceSessionHooks = \{([^}]*)\}/);
    expect(match, 'VoiceSessionHooks の宣言が見つからない').not.toBeNull();
    const members = (match?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*'))
      .map((line) => line.replace(/\?*:.*$/, ''));
    expect(members).toEqual(Object.keys(ALLOWED));
  });

  it.each(Object.entries(ALLOWED))('%s の実装（%s）が起こす受付イベントは許したものだけ', (_, { handler, events }) => {
    const body = handlerBody(readFileSync(KIOSK_FLOW, 'utf8'), handler);
    const dispatched = dispatchedEvents(body);
    // 下界: ハンドラが実際に許したイベントを起こしている（本体の切り出しが空振りしていない）。
    expect(dispatched.length).toBeGreaterThan(0);
    expect(new Set(dispatched)).toEqual(new Set(events));
  });

  it('VoiceSessionLayer へ渡す on* のハンドラは、全部この表に載っている（新しい口が検査から漏れない）', () => {
    const source = readFileSync(KIOSK_FLOW, 'utf8');
    const start = source.indexOf('<VoiceSessionLayer');
    const tag = source.slice(start, source.indexOf('/>', start));
    const handlers = [...tag.matchAll(/\b(on[A-Z]\w*)=\{(\w+)\}/g)].map((m) => ({ prop: m[1] ?? '', fn: m[2] ?? '' }));
    // 受付イベントを起こしうるのは結線の hooks に渡る 2 つだけ。ほかの on* は読み上げ・フォーカスなど
    // 受付状態機械に触れないもので、その本体は dispatch しないことを縛る。
    const nonReception = handlers.filter((h) => !(h.prop in ALLOWED));
    for (const { prop, fn } of handlers) {
      if (prop in ALLOWED) expect(fn, prop).toBe(ALLOWED[prop]?.handler);
    }
    for (const { fn } of nonReception) {
      const body = handlerBody(source, fn);
      expect(body.includes('dispatch('), `${fn} が受付イベントを起こしている`).toBe(false);
    }
    expect(handlers.map((h) => h.prop)).toEqual(expect.arrayContaining(Object.keys(ALLOWED)));
  });

  it('音声で氏名を入れたカスタムフローの送信も SUBMIT_VISITOR_INFO までで止まる（CONFIRM は起きない）', () => {
    // フォームの submit を経由する間接の dispatch（ADR 0011 §1）。
    const source = readFileSync(KIOSK_FLOW, 'utf8');
    const start = source.indexOf('<CustomVisitorInfoView');
    const tag = source.slice(start, source.indexOf('/>', start));
    expect(tag).toContain('formRef={voiceNameFormRef}');
    expect(dispatchedEvents(tag)).toEqual(['SUBMIT_VISITOR_INFO']);
  });

  it('音声のどの経路からも CONFIRM を起こさない（結線・ルーター・氏名の状態機械）', () => {
    for (const file of [
      'src/lib/voice-session/kiosk-binding.ts',
      'src/lib/voice-session/visitor-name-router.ts',
      'src/domain/voice-session/visitor-name-capture.ts',
      'src/components/kiosk/VoiceSessionLayer.tsx',
      'src/components/kiosk/useVoiceSession.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes("'CONFIRM'"), file).toBe(false);
      expect(/dispatch\(\s*\{\s*type:/.test(source), file).toBe(false);
    }
  });
});
