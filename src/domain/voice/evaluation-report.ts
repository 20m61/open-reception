/**
 * 評価レポートの出力 (issue #365)。
 *
 * - JSON  … 機械可読。回帰比較・履歴保存用。スキーマ版数を必ず含める。
 * - CSV   … スプレッドシート / BI での provider 比較用。計測不能は**空セル**（0 と混同させない）。
 * - Markdown … 人が読む用。P50/P95 の provider 横断比較表と SLO 違反の一覧。
 *
 * 生の書き起こしや音声参照は出力しない（レポートは共有されうるため、PII を持ち出さない）。
 */
import type { VoiceEvalProviderResult, VoiceEvalSuiteReport } from './evaluation-runner';

export function toJsonReport(report: VoiceEvalSuiteReport): string {
  return JSON.stringify(report, null, 2);
}

type Column = { header: string; value: (result: VoiceEvalProviderResult) => number | null };

const COLUMNS: Column[] = [
  { header: 'stable_partial_p50_ms', value: (r) => r.metrics.latency.audioOnsetToStablePartial.p50 },
  { header: 'stable_partial_p95_ms', value: (r) => r.metrics.latency.audioOnsetToStablePartial.p95 },
  { header: 'first_partial_p50_ms', value: (r) => r.metrics.latency.audioOnsetToFirstPartial.p50 },
  { header: 'speech_end_to_commit_p50_ms', value: (r) => r.metrics.latency.speechEndToTurnCommitted.p50 },
  { header: 'commit_to_first_audio_p50_ms', value: (r) => r.metrics.latency.turnCommittedToFirstAudio.p50 },
  { header: 'commit_to_first_audio_p95_ms', value: (r) => r.metrics.latency.turnCommittedToFirstAudio.p95 },
  { header: 'barge_in_stop_p50_ms', value: (r) => r.metrics.latency.nearEndOnsetToPlaybackStopped.p50 },
  { header: 'barge_in_stop_p95_ms', value: (r) => r.metrics.latency.nearEndOnsetToPlaybackStopped.p95 },
  { header: 'viseme_sync_error_p50_ms', value: (r) => r.metrics.latency.visemeSyncError.p50 },
  { header: 'cer_p50', value: (r) => r.metrics.stt.cer.p50 },
  { header: 'person_name_exact_match_rate', value: (r) => r.metrics.stt.personNameExactMatchRate },
  { header: 'department_name_exact_match_rate', value: (r) => r.metrics.stt.departmentNameExactMatchRate },
  { header: 'false_commit_rate', value: (r) => r.metrics.turn.falseCommitRate },
  { header: 'missed_end_rate', value: (r) => r.metrics.turn.missedEndRate },
  { header: 'filler_false_response_rate', value: (r) => r.metrics.turn.fillerFalseResponseRate },
  { header: 'true_interruption_detection_rate', value: (r) => r.metrics.bargeIn.trueInterruptionDetectionRate },
  { header: 'false_stop_rate', value: (r) => r.metrics.bargeIn.falseStopRate },
  { header: 'backchannel_false_stop_rate', value: (r) => r.metrics.bargeIn.backchannelFalseStopRate },
  { header: 'echo_false_stop_rate', value: (r) => r.metrics.bargeIn.echoFalseStopRate },
  { header: 'entity_top1_rate', value: (r) => r.metrics.entity.top1Rate },
  { header: 'entity_top3_rate', value: (r) => r.metrics.entity.top3Rate },
];

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

/** 計測不能は空セルにする。0 と書くと「速い/誤りゼロ」と読めてしまう。 */
function numberCell(value: number | null): string {
  return value === null ? '' : String(Number(value.toFixed(4)));
}

export function toCsvReport(report: VoiceEvalSuiteReport): string {
  const header = ['provider', 'slo_passed', ...COLUMNS.map((c) => c.header)].join(',');
  const rows = report.providers.map((result) =>
    [
      csvCell(result.providerId),
      String(result.slo.passed),
      ...COLUMNS.map((column) => numberCell(column.value(result))),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

function mdCell(value: number | null): string {
  return value === null ? '—' : String(Number(value.toFixed(2)));
}

/** 人が読む比較表。P50/P95 を provider 横断で並べ、SLO 違反を根拠付きで列挙する。 */
export function toMarkdownReport(report: VoiceEvalSuiteReport): string {
  const lines: string[] = [];
  lines.push(`# 音声評価レポート (profile: ${report.profile})`);
  lines.push('');
  lines.push(`- 総合判定: **${report.passed ? 'PASS' : 'FAIL'}**`);
  lines.push(`- schema version: ${report.schemaVersion}`);
  lines.push(`- シナリオ数: ${report.scenarioCount}`);
  lines.push('');

  lines.push('## 会話遅延 (ms)');
  lines.push('');
  lines.push(
    '| provider | 確定partial P50 | 確定partial P95 | 応答 P50 | 応答 P95 | 割り込み停止 P50 | 割り込み停止 P95 |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const result of report.providers) {
    const latency = result.metrics.latency;
    lines.push(
      `| ${result.providerId} | ${mdCell(latency.audioOnsetToStablePartial.p50)} | ${mdCell(
        latency.audioOnsetToStablePartial.p95,
      )} | ${mdCell(latency.turnCommittedToFirstAudio.p50)} | ${mdCell(
        latency.turnCommittedToFirstAudio.p95,
      )} | ${mdCell(latency.nearEndOnsetToPlaybackStopped.p50)} | ${mdCell(
        latency.nearEndOnsetToPlaybackStopped.p95,
      )} |`,
    );
  }
  lines.push('');

  lines.push('## 精度・ターン・割り込み');
  lines.push('');
  lines.push('| provider | CER P50 | 人名一致 | 部門名一致 | 誤ターン終了 | 誤停止 | 割り込み検出 | Entity Top3 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of report.providers) {
    const { stt, turn, bargeIn, entity } = result.metrics;
    lines.push(
      `| ${result.providerId} | ${mdCell(stt.cer.p50)} | ${mdCell(stt.personNameExactMatchRate)} | ${mdCell(
        stt.departmentNameExactMatchRate,
      )} | ${mdCell(turn.falseCommitRate)} | ${mdCell(bargeIn.falseStopRate)} | ${mdCell(
        bargeIn.trueInterruptionDetectionRate,
      )} | ${mdCell(entity.top3Rate)} |`,
    );
  }
  lines.push('');

  lines.push('## SLO 判定');
  lines.push('');
  for (const result of report.providers) {
    lines.push(`### ${result.providerId} — ${result.slo.passed ? 'PASS' : 'FAIL'}`);
    lines.push('');
    for (const error of result.schemaErrors) lines.push(`- スキーマ違反: ${error}`);
    for (const error of result.errors) lines.push(`- 実行エラー: ${error}`);
    for (const violation of result.slo.violations) {
      lines.push(`- 違反 \`${violation.metric}\`: 実測 ${violation.observed ?? '—'} / 許容 ${violation.allowed}`);
    }
    for (const skip of result.slo.skipped) lines.push(`- 判定不能 \`${skip.metric}\`: ${skip.reason}`);
    if (
      result.slo.violations.length === 0 &&
      result.slo.skipped.length === 0 &&
      result.schemaErrors.length === 0 &&
      result.errors.length === 0
    ) {
      lines.push('- 指摘なし');
    }
    lines.push('');
  }

  return lines.join('\n');
}
