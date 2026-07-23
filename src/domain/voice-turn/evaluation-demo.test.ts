/**
 * #372 の #365 適合ゲート (issue #372 運用制約: 「validateVoiceEvalSession(session).errors 空 +
 * ci プロファイルのゲートを通すことを実証する」)。
 *
 * `buildVoiceTurnDemoSession()` は正解ラベルを一切参照しない実装（`turn-detector.ts` /
 * `near-end-classifier.ts` / `barge-in-controller.ts`）だけでイベント列を構築する。
 * ここでは「schemaValidation が空」「ci プロファイルで green」に加えて、指標が
 * **無条件に緑になっていないこと**（分母 0 の skip に頼っていないこと）も固定する
 * （`docs/loop-workflow.md` 運用制約「p50<0.3 のような無条件 0 で通る assertion を書かない」）。
 */
import { describe, expect, it } from 'vitest';

import { validateVoiceEvalSession } from '@/domain/voice/evaluation-events';
import { computeSessionMetrics } from '@/domain/voice/evaluation-metrics';
import { evaluateAgainstSlo, VOICE_EVAL_PROFILES } from '@/domain/voice/evaluation-thresholds';

import { buildVoiceTurnDemoSession } from './evaluation-demo';

describe('buildVoiceTurnDemoSession', () => {
  it('#365 共通スキーマを満たす', () => {
    const { session } = buildVoiceTurnDemoSession();
    expect(validateVoiceEvalSession(session).errors).toEqual([]);
  });

  it('決定論的である（同じ実装呼び出しなら同じイベント列）', () => {
    expect(buildVoiceTurnDemoSession().session.events).toEqual(buildVoiceTurnDemoSession().session.events);
  });

  it('短答は不要な待機をせず短い無音で確定する（turn 0）', () => {
    const { session } = buildVoiceTurnDemoSession();
    const committed = session.events.find((e) => e.type === 'turn.committed' && e.turnIndex === 0);
    expect(committed).toBeDefined();
    if (committed?.type !== 'turn.committed') throw new Error('unreachable');
    expect(committed.trigger).toBe('silence');
    expect(committed.t).toBeLessThan(1000); // 短答の閾値どおりであれば十分速い。
  });

  it('フィラーで終わる発話は途中の無音では確定しない（turn 1, issue AC）', () => {
    const { session } = buildVoiceTurnDemoSession();
    expect(session.events.some((e) => e.type === 'turn.committed' && e.turnIndex === 1)).toBe(false);
  });

  it('相づちでは再生を止めず、明示的な訂正で速やかに停止する（turn 2）', () => {
    const { session } = buildVoiceTurnDemoSession();
    const stopped = session.events.find((e) => e.type === 'tts.playback_stopped' && e.turnIndex === 2);
    expect(stopped).toBeDefined();
    if (stopped?.type !== 'tts.playback_stopped') throw new Error('unreachable');
    expect(stopped.reason).toBe('barge_in');

    const metrics = computeSessionMetrics(session);
    // 相づち・エコー・環境音のいずれも誤停止していない（実装が「何でも止める」policy でないこと）。
    expect(metrics.bargeIn.falseStopRate).toBe(0);
    expect(metrics.bargeIn.trueInterruptionDetectionRate).toBe(1);
  });

  it('エコー相当・環境音相当の近端発話でも誤って割り込みと判定しない（turn 3, 4）', () => {
    const { session } = buildVoiceTurnDemoSession();
    const stopped3 = session.events.find((e) => e.type === 'tts.playback_stopped' && e.turnIndex === 3);
    const stopped4 = session.events.find((e) => e.type === 'tts.playback_stopped' && e.turnIndex === 4);
    expect(stopped3).toMatchObject({ reason: 'completed' });
    expect(stopped4).toMatchObject({ reason: 'completed' });
  });

  it('barge-in 停止は帰属できる範囲の反応時間で発生する（原因不明の停止を生まない）', () => {
    const { session } = buildVoiceTurnDemoSession();
    const metrics = computeSessionMetrics(session);
    expect(metrics.bargeIn.unattributedStopCount).toBe(0);
    expect(metrics.raw.bargeIn.bargeInStops).toBe(1); // barge_in 停止は turn2 の 1 件だけ。
  });

  it('ci プロファイルの SLO を満たす（無条件緑ではなく、実測が閾値内であることを確認する）', () => {
    const { session } = buildVoiceTurnDemoSession();
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors).toEqual([]);

    const metrics = computeSessionMetrics(session);
    const suiteMetrics = { sessionCount: 1, ...metrics };
    const slo = evaluateAgainstSlo(suiteMetrics, VOICE_EVAL_PROFILES.ci.thresholds, { strict: VOICE_EVAL_PROFILES.ci.strict });

    expect(slo.violations).toEqual([]);
    expect(slo.passed).toBe(true);

    // 分母 0 の skip に頼って緑になっていないことを固定する —— ターン・割り込みの主要指標は
    // 実測値を持つ（null ではない）。
    expect(metrics.turn.falseCommitRate).not.toBeNull();
    expect(metrics.turn.missedEndRate).not.toBeNull();
    expect(metrics.bargeIn.trueInterruptionDetectionRate).not.toBeNull();
    expect(metrics.bargeIn.falseStopRate).not.toBeNull();
    expect(metrics.bargeIn.nearEndOnsetDetectionRate).not.toBeNull();
    expect(metrics.turn.falseCommitRate).toBe(0);
    expect(metrics.turn.missedEndRate).toBe(0);
    expect(metrics.bargeIn.nearEndOnsetDetectionRate).toBe(1);
  });

  it('ターンを一切確定しない実装（何もしない provider）は同じ SLO で緑にならない', () => {
    // 対称な SLO ゲート（`docs/voice-evaluation-harness.md`）が効いていることを、
    // 「何もしない」実装を模した壊れたセッションで確認する（甘い assertion の回帰防止）。
    const { session } = buildVoiceTurnDemoSession();
    const doNothing = { ...session, events: session.events.filter((e) => e.type !== 'turn.committed' && e.type !== 'tts.playback_stopped') };
    const metrics = computeSessionMetrics(doNothing);
    const suiteMetrics = { sessionCount: 1, ...metrics };
    const slo = evaluateAgainstSlo(suiteMetrics, VOICE_EVAL_PROFILES.ci.thresholds, { strict: VOICE_EVAL_PROFILES.ci.strict });
    expect(slo.passed).toBe(false);
    expect(slo.violations.map((v) => v.metric)).toContain('maxMissedEndRate');
  });
});
