import { describe, expect, it } from 'vitest';
import { createAiGuidanceSession } from '@/domain/ai-guidance';
import { MockGuidanceProvider, MockHandoffChannel } from './mock';
import { finalizeFallback, performHandoff, runGuidanceTurn } from './orchestrator';
import type { GuidanceProvider, GuidanceResponse } from './types';

const T0 = '2026-06-20T00:00:00.000Z';
const ALLOWED = ['faq', 'facility', 'reception_op'];

function session() {
  return createAiGuidanceSession({ id: 's1', kioskId: 'k1', now: T0 });
}

function turnInput(utterance: string) {
  return { locale: 'ja', utterance, allowedTopics: ALLOWED, now: T0 };
}

/** 固定応答を返すスタブ provider。 */
function stubProvider(response: GuidanceResponse): GuidanceProvider {
  return { id: 'stub', generate: () => Promise.resolve(response) };
}

describe('ai-guidance orchestrator', () => {
  it('正常案内では guiding のまま回答を返す（即時実行しない）', async () => {
    const result = await runGuidanceTurn(session(), turnInput('受付の操作を教えて'), new MockGuidanceProvider());
    expect(result.session.state).toBe('guiding');
    expect(result.escalated).toBe(false);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('NG ワードでエスカレーションし回答を見せない（誤案内フォールバック）', async () => {
    const result = await runGuidanceTurn(session(), turnInput('緊急です'), new MockGuidanceProvider());
    expect(result.session.state).toBe('handoff_requested');
    expect(result.session.escalationReason).toBe('ng_word');
    expect(result.escalated).toBe(true);
    expect(result.answer).toBe('');
  });

  it('スコープ外質問は低信頼でエスカレーション（誤案内防止）', async () => {
    const result = await runGuidanceTurn(session(), turnInput('今日の天気は'), new MockGuidanceProvider());
    expect(result.session.state).toBe('handoff_requested');
    expect(result.answer).toBe('');
  });

  it('低信頼応答でエスカレーションする', async () => {
    const provider = stubProvider({ answer: 'たぶん…', confidence: 0.2, ngWordDetected: false, outOfScope: false });
    const result = await runGuidanceTurn(session(), turnInput('xxx'), provider);
    expect(result.session.escalationReason).toBe('low_confidence');
    expect(result.escalated).toBe(true);
  });

  it('performHandoff 成功で handed_off へ（引き継ぎの成否は人間導線が決める）', async () => {
    const escalated = await runGuidanceTurn(session(), turnInput('緊急です'), new MockGuidanceProvider());
    const done = await performHandoff(escalated.session, new MockHandoffChannel(true), T0);
    expect(done.state).toBe('handed_off');
  });

  it('performHandoff 失敗→finalizeFallback で代替導線へ戻し終端化する', async () => {
    const escalated = await runGuidanceTurn(session(), turnInput('緊急です'), new MockGuidanceProvider());
    const failed = await performHandoff(escalated.session, new MockHandoffChannel(false), T0);
    expect(failed.state).toBe('failed');
    const fellBack = finalizeFallback(failed, T0);
    expect(fellBack.state).toBe('handed_off');
  });

  it('handoff_requested 以外で performHandoff を呼んでも状態を変えない', async () => {
    const s = session();
    const same = await performHandoff(s, new MockHandoffChannel(true), T0);
    expect(same).toBe(s);
  });

  it('failed 以外で finalizeFallback を呼んでも状態を変えない', () => {
    const s = session();
    expect(finalizeFallback(s, T0)).toBe(s);
  });

  it('provider の回答テキストはエスカレーション判定に影響しない（計量値のみ使用）', async () => {
    // 高信頼でも outOfScope なら未解決扱いでエスカレーションしうるが、ここでは
    // 回答テキストが空でも confidence が高ければ guiding を維持することを確認。
    const provider = stubProvider({ answer: '', confidence: 0.95, ngWordDetected: false, outOfScope: false });
    const result = await runGuidanceTurn(session(), turnInput('案内'), provider);
    expect(result.session.state).toBe('guiding');
  });
});
