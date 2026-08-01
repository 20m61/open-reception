/**
 * 定期ゲート実行記録（`docs/gate-runs.md`）の評価 (issue #424)。
 *
 * #424 は「事前定義した成功/停止条件で評価し、未達なら次の Issue や rollback 提案を
 * 生成する」ことを求めている。**KPI の評価はまだ作らない** — 稼働環境の実データが無く、
 * 今作れば消費者ゼロの契約になる（`docs/ai-development-loop.md` §8）。
 *
 * 一方、定期ゲートの実行記録は #318 の週次 Routine が動き出して**実データが入り始めた**。
 * ここは全ての指摘が実データに基づくので、先にこちらを評価対象にする。
 *
 * 見るのは「仕組みが回っているか」と「ゲートが黙って弱くなっていないか」:
 *   - 一度も回っていない / 週次を超えて止まっている
 *   - 直近が FAIL のまま
 *   - FAIL なのに issue 参照が無い（FAIL 時ハンドリングの漏れ）
 *   - SKIP が記録されている（`--strict` 下では出ないはず＝strict 未使用か環境劣化）
 *
 * 判定は純関数。ファイル読み込みと出力は `scripts/evaluate-gate-runs.ts` に置く。
 */

export type GateRun = {
  /** 実行開始時刻（記録上の文字列。例 `2026-07-31T22:58Z`）。 */
  at: string;
  sha: string;
  tier: string;
  result: 'PASS' | 'FAIL';
  /** SKIP 項目。「なし」は空配列として扱う。 */
  skipped: string[];
  /** 起票 issue / 備考の生文字列。 */
  note: string;
};

export type GateRunFinding = {
  code: 'never_run' | 'stale' | 'latest_failed' | 'fail_without_issue' | 'skipped_steps';
  severity: 'error' | 'warning';
  message: string;
};

/** 週次運用なので、これを超えたら「止まっている」とみなす。 */
const STALE_AFTER_DAYS = 8;

/** EXAMPLE 行は実データではない（ファイル自身がそう明記している）。 */
function isExampleRow(cells: string[]): boolean {
  return cells.some((c) => c.includes('EXAMPLE'));
}

/**
 * `docs/gate-runs.md` から実行記録を抜く。**新しい順**で返す。
 *
 * 同ファイルには「記録フォーマット」の説明表も在るので、**日時列の形を満たす行だけ**を
 * 実データとして拾う（見出しや説明表に釣られない）。
 */
export function parseGateRuns(markdown: string): GateRun[] {
  const runs: GateRun[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    const at = cells[0] ?? '';
    // 日時列の体裁を満たさない行（説明表・ヘッダ・区切り）は実データではない。
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(at)) continue;
    if (isExampleRow(cells)) continue;
    const result = (cells[3] ?? '').toUpperCase();
    if (result !== 'PASS' && result !== 'FAIL') continue;
    const skipRaw = cells[4] ?? '';
    runs.push({
      at,
      sha: (cells[1] ?? '').replace(/`/g, ''),
      tier: cells[2] ?? '',
      result,
      skipped: skipRaw === '' || skipRaw === 'なし' ? [] : skipRaw.split(';').map((s) => s.trim()),
      note: cells[5] ?? '',
    });
  }
  return runs.sort((a, b) => b.at.localeCompare(a.at));
}

/** 備考に issue 参照（`#123`）が入っているか。 */
function hasIssueReference(note: string): boolean {
  return /#\d+/.test(note);
}

export function evaluateGateRuns(runs: readonly GateRun[], now: Date): GateRunFinding[] {
  const findings: GateRunFinding[] = [];

  if (runs.length === 0) {
    // **「仕組みは作ったが回っていない」を最優先で可視化する。** #318 の週次 Routine は
    // 長らく未作成で、このファイルは EXAMPLE 行だけだった。仕組みの存在と稼働は別。
    return [
      {
        code: 'never_run',
        severity: 'error',
        message:
          '定期ゲートの実行記録がありません。週次 Routine が作成・稼働しているか確認してください（docs/quality-gate.md「定期運用」）。',
      },
    ];
  }

  const latest = runs[0];
  if (!latest) return findings;

  const elapsedDays = (now.getTime() - Date.parse(latest.at)) / 86_400_000;
  if (elapsedDays > STALE_AFTER_DAYS) {
    findings.push({
      code: 'stale',
      severity: 'error',
      message: `最終実行から ${Math.floor(elapsedDays)} 日経過しています（週次運用の想定は ${STALE_AFTER_DAYS} 日以内）。Routine が止まっていないか確認してください。`,
    });
  }

  if (latest.result === 'FAIL') {
    findings.push({
      code: 'latest_failed',
      severity: 'error',
      message: `直近の定期ゲート（${latest.at} / ${latest.sha}）が FAIL のままです。`,
    });
  }

  // **FAIL 行だけを見て判定しない。** `record-gate-run.sh` は issue 起票の**前**に行を
  // 書くので備考は必ずプレースホルダになり、記録は append-only なので後から追記できない。
  // FAIL 行単体で判定すると**永久に消えない指摘**になり、検査が狼少年になる。
  // 実際の運用は「FAIL → 起票 → 修正 → 再実行し、その行に顛末を書く」なので、
  // **後続行の参照をもって解決とみなす**（runs は新しい順なので、より前の要素が後続）。
  for (const [i, run] of runs.entries()) {
    if (run.result !== 'FAIL') continue;
    const laterRuns = runs.slice(0, i);
    if (hasIssueReference(run.note) || laterRuns.some((r) => hasIssueReference(r.note))) continue;
    findings.push({
      code: 'fail_without_issue',
      severity: 'warning',
      message: `FAIL した実行（${run.at}）に issue 参照がなく、その後の記録にもありません。FAIL 時は issue 起票が運用ルールです（docs/quality-gate.md「FAIL 時のハンドリング」）。`,
    });
  }

  for (const run of runs.filter((r) => r.skipped.length > 0)) {
    findings.push({
      code: 'skipped_steps',
      severity: 'warning',
      message: `SKIP が記録されています（${run.at}: ${run.skipped.join(', ')}）。--strict 下では SKIP は FAIL になるはずで、strict 未使用か実行環境からツールが欠けています。`,
    });
  }

  return findings;
}
