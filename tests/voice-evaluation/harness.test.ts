/**
 * 評価ハーネスのオフライン実行 (issue #365)。
 *
 * 合成データセットを複数 provider に流し、指標算出 → SLO 判定 → レポート出力までを
 * ネットワーク・実音声なしで再現する。「基準 provider は緑」「1 ノブ崩すと該当指標だけ赤」
 * を確認することで、SLO 低下がレポートで検知できることを担保する（#365 AC）。
 *
 * テストの書き方の約束:
 * - **違反集合は完全一致で固定する**（`toContain` で済ませない）。1 ノブの劣化が、意図した指標
 *   だけを赤くし、他を巻き込まないことまで含めて検証するため。
 * - **必ず `schemaErrors` も検証する**。セッションが検証で落ちて計測されないまま
 *   「違反 0 件」で緑に見える事故を防ぐ。
 */
import { describe, expect, it } from 'vitest';

import { validateVoiceEvalSession } from '@/domain/voice/evaluation-events';
import { toCsvReport, toJsonReport, toMarkdownReport } from '@/domain/voice/evaluation-report';
import { runVoiceEvalSuite, type VoiceEvalProvider } from '@/domain/voice/evaluation-runner';
import { VOICE_EVAL_PROFILES } from '@/domain/voice/evaluation-thresholds';

import { VOICE_EVAL_DATASET, VOICE_EVAL_SCENARIOS } from './dataset';
import { BASELINE_SYNTHETIC_CONFIG, createSyntheticProvider, type SyntheticProviderConfig } from './synthetic-provider';

function provider(id: string, overrides: Partial<SyntheticProviderConfig> = {}): VoiceEvalProvider {
  return createSyntheticProvider(
    {
      ...BASELINE_SYNTHETIC_CONFIG,
      id,
      providers: { stt: `${id}-stt`, tts: `${id}-tts`, turn: `${id}-turn` },
      ...overrides,
    },
    VOICE_EVAL_DATASET,
  );
}

const profile = VOICE_EVAL_PROFILES.uat;

async function runWith(p: VoiceEvalProvider) {
  const report = await runVoiceEvalSuite({ providers: [p], scenarios: VOICE_EVAL_SCENARIOS, profile });
  const result = report.providers[0];
  if (!result) throw new Error('provider result missing');
  return { report, result, violations: result.slo.violations.map((v) => v.metric).sort() };
}

describe('データセット', () => {
  it('#365 が挙げる切り口を網羅している', () => {
    const tags = new Set(VOICE_EVAL_SCENARIOS.flatMap((s) => s.tags));
    for (const required of ['person-name', 'homophone', 'department', 'filler', 'barge-in', 'backchannel', 'echo']) {
      expect(tags.has(required)).toBe(true);
    }
  });

  it('実音声への参照を一切持たない（合成発話のみ）', () => {
    for (const scenario of VOICE_EVAL_SCENARIOS) {
      expect(scenario.input.kind).toBe('synthetic');
    }
  });

  it('近端発話の正解を刺激の絶対時刻として持つ（観測の通番に依存しない）', () => {
    const stimuli = VOICE_EVAL_SCENARIOS.flatMap((s) => s.groundTruth.nearEndStimuli);
    expect(stimuli.length).toBeGreaterThan(0);
    for (const stimulus of stimuli) {
      expect(stimulus.atMs).toBeGreaterThan(0);
      expect(stimulus.toleranceMs).toBeGreaterThan(0);
      expect(stimulus.id).not.toBe('');
    }
  });
});

describe('合成 provider の適合', () => {
  it('生成したセッションが共通スキーマを満たす（#369〜#372 の適合ゲートと同じ検証）', async () => {
    const p = provider('baseline');
    for (const scenario of VOICE_EVAL_SCENARIOS) {
      const session = await p.run(scenario);
      expect(validateVoiceEvalSession(session).errors).toEqual([]);
    }
  });

  it('決定論的である（同じ入力なら同じイベント列）', async () => {
    const first = await provider('baseline').run(VOICE_EVAL_SCENARIOS[0]!);
    const second = await provider('baseline').run(VOICE_EVAL_SCENARIOS[0]!);
    expect(first.events).toEqual(second.events);
  });

  it('transport イベントを出す（#369 が計測値を出せる形になっている）', async () => {
    const session = await provider('baseline').run(VOICE_EVAL_SCENARIOS[0]!);
    expect(session.events.map((e) => e.type)).toContain('transport.connected');
    expect(session.events.map((e) => e.type)).toContain('transport.stream_open');
  });
});

describe('SLO 判定', () => {
  it('基準 provider は実機 SLO を全項目満たす', async () => {
    const { result, violations } = await runWith(provider('baseline'));
    expect(violations).toEqual([]);
    expect(result.schemaErrors).toEqual([]);
    expect(result.slo.skipped).toEqual([]); // uat は strict なので skipped も出ない
    expect(result.passed).toBe(true);
    expect(result.metrics.sessionCount).toBe(VOICE_EVAL_SCENARIOS.length);
  });

  it('確定 partial を遅くすると該当指標だけが違反になる', async () => {
    const { result, violations } = await runWith(provider('slow-stt', { stablePartialMs: 900 }));
    expect(violations).toEqual(['stablePartialP50Ms']);
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.latency.audioOnsetToStablePartial.p50).toBe(900);
  });

  it('応答音声を遅くすると first audio の SLO が違反になる', async () => {
    const { result, violations } = await runWith(provider('slow-tts', { firstAudioMs: 900, firstByteMs: 800 }));
    expect(violations).toContain('shortAnswerFirstAudioP50Ms');
    expect(result.schemaErrors).toEqual([]);
  });

  it('相づちで止まる provider は誤割り込み率で落ちる', async () => {
    const { result, violations } = await runWith(provider('naive-barge-in', { bargeInPolicy: 'naive' }));
    expect(violations).toEqual([
      'maxFalseStopRate',
      'minNearEndOnsetDetectionRate',
      'minTrueInterruptionDetectionRate',
    ]);
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.bargeIn.backchannelFalseStopRate).toBe(1);
    expect(result.metrics.bargeIn.echoFalseStopRate).toBe(1);
    expect(result.metrics.bargeIn.falseStopRate).toBe(0.75);
  });

  it('割り込みを一切止めない provider は「誤停止 0」でも緑にならない', async () => {
    // 非対称な SLO セットだと、何もしない provider が最も安い緑になってしまう。
    const { result, violations } = await runWith(provider('deaf', { bargeInPolicy: 'deaf' }));
    expect(result.metrics.bargeIn.falseStopRate).toBe(0);
    expect(result.metrics.bargeIn.trueInterruptionDetectionRate).toBe(0);
    // 一度も止めないので停止に関する指標は全て計測不能。uat は strict なので計測不能自体が違反。
    expect(violations).toEqual([
      'bargeInStopP50Ms',
      'bargeInStopP95Ms',
      'maxUnattributedBargeInStopRate',
      'minTrueInterruptionDetectionRate',
    ]);
    expect(result.passed).toBe(false);
    expect(result.schemaErrors).toEqual([]);
  });

  it('検出遅れが許容予算の内側なら、刺激との対応は保たれる', async () => {
    // 実 provider の onset は VAD のハングオーバ等で刺激より遅れる。予算 (STIMULUS_TOLERANCE_MS)
    // の内側なら「onset が少し遅い」であって検出漏れではない。
    const { result, violations } = await runWith(provider('laggy-onset', { onsetLagMs: 250 }));
    expect(result.metrics.bargeIn.nearEndOnsetDetectionRate).toBe(1);
    expect(result.metrics.bargeIn.spuriousNearEndOnsetCount).toBe(0);
    expect(violations).toEqual([]);
  });

  it('検出遅れが予算を超えると検出漏れ + 誤検出として現れる（予算の崖を固定する）', async () => {
    // 予算を超えた時点で「1 件も検出できず、幻の検出が同数ある」という採点になる。
    // 崖の存在自体を固定しておき、実 provider の実測でずれが出たら予算と刺激間隔を見直す。
    const { result } = await runWith(provider('very-laggy-onset', { onsetLagMs: 400 }));
    expect(result.metrics.bargeIn.nearEndOnsetDetectionRate).toBe(0);
    expect(result.metrics.bargeIn.spuriousNearEndOnsetCount).toBeGreaterThan(0);
  });

  it('フィラーで切る provider は誤ターン終了率だけで落ちる', async () => {
    const { result, violations } = await runWith(provider('naive-turn', { turnPolicy: 'naive' }));
    expect(violations).toEqual(['maxFalseCommitRate']);
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.turn.falseCommitRate).toBe(1);
    expect(result.metrics.turn.fillerFalseResponseRate).toBe(1);
    expect(result.metrics.turn.missedEndRate).toBe(0);
  });

  it('ターンを取りこぼす provider は誤終了 0 のまま終了見逃しで落ちる（スキーマ違反にしない）', async () => {
    // 以前はターン脱落で近端発話の注釈が無効になり、セッションが検証で落ちて 8 件中 5 件しか
    // 集計されていなかった。ターンの脱落は性能の失敗であって計測の失敗ではない。
    const { result, violations } = await runWith(provider('slow-turn', { turnPolicy: 'slow' }));
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.sessionCount).toBe(VOICE_EVAL_SCENARIOS.length);
    expect(result.metrics.turn.falseCommitRate).toBe(0);
    expect(result.metrics.turn.missedEndRate).toBeCloseTo(0.8);
    expect(violations).toContain('maxMissedEndRate');
  });

  it('担当者候補の順位が落ちると Top3 は保たれても Top1 が下がる', async () => {
    const { result, violations } = await runWith(provider('rank3', { entityRank: 3 }));
    expect(result.metrics.entity.top3Rate).toBe(1);
    expect(result.metrics.entity.top1Rate).toBe(0);
    expect(violations).toEqual([]); // Top3 SLO は満たすので赤にはしない
  });

  it('候補から漏れると Top3 SLO で落ちる', async () => {
    const { result, violations } = await runWith(provider('entity-miss', { entityRank: 'miss' }));
    expect(violations).toEqual(['minEntityTop3Rate']);
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.entity.top3Rate).toBe(0);
  });

  it('途中で終わる provider は「イベントが少ないだけ」に見えず、中断として赤くなる', async () => {
    const { result, violations } = await runWith(provider('aborting', { abortAtTurn: 0 }));
    expect(result.schemaErrors).toEqual([]);
    expect(result.metrics.reliability.abortedSessionRate).toBe(1);
    expect(violations).toContain('maxAbortedSessionRate');
    expect(result.passed).toBe(false);
  });
});

describe('固有名詞の精度は CER と別に見える', () => {
  it('同音異字の取り違えは CER が小さくても人名一致率で落ちる', async () => {
    const { result, violations } = await runWith(
      provider('homophone', { misrecognitions: { 斎藤: '佐藤', 山田: '山下' } }),
    );

    // コーパス CER は 2.4% と小さく、CER だけを見ていると回帰に気付けない。
    expect(result.metrics.stt.corpusCer).toBeCloseTo(0.024);
    // 発話ごとの CER も最大で 9% 程度。ただし「厳密に 0 より大きい」ことは確認する
    // （CER が常に 0 を返す実装でもテストが通ってしまうのを防ぐ）。
    expect(result.metrics.stt.cer.max).toBeGreaterThan(0);
    expect(result.metrics.stt.cer.max).toBeLessThan(0.1);
    // 一方で人名一致率は 3 件中 1 件まで落ちる。
    expect(result.metrics.stt.personNameExactMatchRate).toBeCloseTo(1 / 3);
    expect(violations).toContain('minPersonNameExactMatchRate');
    expect(violations).not.toContain('maxCorpusCer');
  });

  it('誤りを注入しない provider は人名も部門名も完全一致する', async () => {
    const { result } = await runWith(provider('clean'));
    expect(result.metrics.stt.cer.max).toBe(0);
    expect(result.metrics.stt.corpusCer).toBe(0);
    expect(result.metrics.stt.personNameExactMatchRate).toBe(1);
    expect(result.metrics.stt.departmentNameExactMatchRate).toBe(1);
  });
});

describe('provider 比較とレポート', () => {
  it('同一データセットで複数 provider を比較できる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('transcribe'), provider('browser', { stablePartialMs: 700, entityRank: 2 })],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile,
    });

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(250);
    expect(report.providers[1]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(700);
    expect(report.providers[0]?.passed).toBe(true);
    expect(report.providers[1]?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('JSON / CSV / Markdown を出力できる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('transcribe'), provider('browser', { stablePartialMs: 700 })],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile,
    });

    expect(JSON.parse(toJsonReport(report)).providers).toHaveLength(2);
    expect(toCsvReport(report).trim().split('\n')).toHaveLength(3);

    const markdown = toMarkdownReport(report);
    expect(markdown).toContain('| transcribe |');
    expect(markdown).toContain('stablePartialP50Ms');
  });

  it('レポートに生の書き起こしを載せない（共有されうるため PII を持ち出さない）', async () => {
    const { report } = await runWith(provider('baseline'));
    const json = toJsonReport(report);
    expect(json).not.toContain('山田');
    expect(json).not.toContain('アクメコーポレーション');
  });
});

describe('プロファイル', () => {
  it('軽量な ci プロファイルは合成データの基準 provider で緑になる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('baseline')],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile: VOICE_EVAL_PROFILES.ci,
    });
    expect(report.passed).toBe(true);
  });
});
