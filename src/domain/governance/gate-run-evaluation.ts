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
  code:
    | 'never_run'
    | 'stale'
    | 'latest_failed'
    | 'fail_without_issue'
    | 'skipped_steps'
    | 'non_full_record'
    | 'record_gap';
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

  // **定期実行の証跡は `full` の記録だけ。** 設定を誤った Routine や手入力が `fast`/`pr` の
  // PASS を積むと、`--full --strict` が回っていないのに stale が解除され報告も緑になる。
  if (runs.length > 0 && runs[0]?.tier !== 'full') {
    findings.push({
      code: 'non_full_record',
      severity: 'warning',
      message: `直近の記録の tier が '${runs[0]?.tier}' です。定期実行は --full --strict が前提で、それ以外は証跡になりません。`,
    });
  }
  const fullRuns = runs.filter((r) => r.tier === 'full');

  if (fullRuns.length === 0) {
    // **「仕組みは作ったが回っていない」を最優先で可視化する。** #318 の週次 Routine は
    // 長らく未作成で、このファイルは EXAMPLE 行だけだった。仕組みの存在と稼働は別。
    return [
      {
        code: 'never_run',
        severity: 'error',
        message:
          '定期ゲート（--full）の実行記録がありません。週次 Routine が作成・稼働しているか確認してください（docs/quality-gate.md「定期運用」）。',
      },
      ...findings,
    ];
  }

  const latest = fullRuns[0];
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

  // **`stale` は直近 1 件の経過日数しか見ない**ので、記録の**途中**の穴は次の回が
  // 載った時点で見えなくなる。#656 で実際に起きたのがこれ（routine は記録を push したが
  // PR を作らず、FAIL の記録が 5 日間 main に無かった）。穴は隣接する記録の間隔で捕まえる。
  //
  // **解決手段はある** — 抜けた回の行を追記すれば消える（並び順は `at` で決まるので
  // 後から挿せる）。ゲート出力が復元不能でも、経緯を備考に書いた行で連続性は取り戻せる。
  for (let i = 0; i + 1 < fullRuns.length; i += 1) {
    const newer = fullRuns[i];
    const older = fullRuns[i + 1];
    if (!newer || !older) continue;
    const gapDays = (Date.parse(newer.at) - Date.parse(older.at)) / 86_400_000;
    if (gapDays <= STALE_AFTER_DAYS) continue;
    findings.push({
      code: 'record_gap',
      severity: 'error',
      message: `${older.at} と ${newer.at} の間が ${Math.floor(gapDays)} 日空いています（週次運用の想定は ${STALE_AFTER_DAYS} 日以内）。その間の定期実行の記録が main に載っていない可能性があります（#656）。抜けた回の行を追記してください。`,
    });
  }

  // **FAIL 行だけを見て判定しない。** `record-gate-run.sh` は issue 起票の**前**に行を
  // 書くので備考は必ずプレースホルダになり、記録は append-only なので後から追記できない。
  // FAIL 行単体で判定すると**永久に消えない指摘**になり、検査が狼少年になる。
  //
  // ただし「以降のどこかに #N があれば解決」も緩すぎる — **別件の参照で古い FAIL まで
  // 消える**。実際の運用は「FAIL → 起票 → 修正 → 再実行し、**その行に**顛末を書く」なので、
  // **直後の 1 行**に限定する（runs は新しい順なので i-1 が直後）。
  for (const [i, run] of runs.entries()) {
    if (run.result !== 'FAIL') continue;
    const nextRun = i > 0 ? runs[i - 1] : undefined;
    if (hasIssueReference(run.note) || (nextRun && hasIssueReference(nextRun.note))) continue;
    findings.push({
      code: 'fail_without_issue',
      severity: 'warning',
      message: `FAIL した実行（${run.at}）に issue 参照がなく、その後の記録にもありません。FAIL 時は issue 起票が運用ルールです（docs/quality-gate.md「FAIL 時のハンドリング」）。`,
    });
  }

  // **SKIP も「解決」を持たせる。** append-only なので過去の SKIP 行は消せず、既定が
  // exit 1 のままだと**評価器が二度と緑にならない**（FAIL で直したのと同じ罠）。
  // ツールが復旧したことは「その後の `--full` が SKIP 無しで PASS した」ことで証明できる。
  for (const [i, run] of runs.entries()) {
    if (run.skipped.length === 0) continue;
    const recovered = runs
      .slice(0, i)
      .some((r) => r.tier === 'full' && r.result === 'PASS' && r.skipped.length === 0);
    if (recovered) continue;
    findings.push({
      code: 'skipped_steps',
      severity: 'warning',
      message: `SKIP が記録されています（${run.at}: ${run.skipped.join(', ')}）。--strict 下では SKIP は FAIL になるはずで、strict 未使用か実行環境からツールが欠けています。`,
    });
  }

  return findings;
}
