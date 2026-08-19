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
    | 'record_gap'
    | 'orphan_branch'
    | 'branch_check_unverified'
    | 'unmeasured_scope';
  severity: 'error' | 'warning';
  message: string;
};

/**
 * 「変更範囲を測れなかった」印 (#717)。`scripts/record-gate-run.sh` が備考へ書く。
 *
 * **列は増やさない。** `parseGateRuns` は位置で読むので、列を足すと既存行が全部ずれる。
 */
export const UNMEASURED_MARK = '未測定:';

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

  // 🔴 **「測れなかった」実行を数える** (#717)。クラウド（`--pr` / `--full` の既定実行
  // 環境）は浅い clone なので、変更範囲を測れずに全ステップを走らせる状態が
  // **恒常的に起きていても気づけない**。その場の ⚠ は流れて消えるので、
  // コミットされる記録に付いた印をここで拾う。
  //
  // **error ではなく warning。** 測れなかったときは `code` へ倒して全ステップ走らせる
  // （＝検証は省略されていない）ので、ゲートの健全性としては赤ではない。
  // ただし毎回起きているなら環境（clone の深さ・起点解決）を直す合図になる。
  const unmeasured = runs.filter((run) => run.note.includes(UNMEASURED_MARK));
  if (unmeasured.length > 0) {
    findings.push({
      code: 'unmeasured_scope',
      severity: 'warning',
      message:
        `変更範囲を測れなかった実行が ${unmeasured.length} 件あります` +
        `（直近: ${unmeasured[unmeasured.length - 1]!.at}）。` +
        '検証は省略されていません（測れないときは code へ倒す）が、恒常的なら ' +
        'clone の深さや起点解決を直す合図です。',
    });
  }

  return findings;
}

/** リモートに実在するブランチ。 */
export type RemoteBranch = {
  name: string;
  /**
   * 先端コミットの日時（ISO 8601）。**取れなければ省く。**
   *
   * 「PR がまだ無い」だけでは取りこぼしと正常な作業中を区別できないので、経過時間で分ける。
   */
  tipCommittedAt?: string;
};

/** 取りこぼし判定の窓。 */
export type RecordBranchOptions = {
  now: Date;
  /** これを超えて PR が付かないものだけを取りこぼしとみなす。 */
  graceHours: number;
};

/**
 * **push されたが PR にならなかったブランチ**を捕まえる (#656)。
 *
 * `docs/gate-runs.md` の穴（`record_gap`）は「記録が main に無い」ことを事後に検出するが、
 * **穴が空いた理由**まではわからない。#656 の実例は「週次 routine が記録を commit・push した
 * のに PR を作らずに終わった」で、`chore/gate-run-20260803` は**紐づく PR が 1 つも無い**まま
 * 5 日間放置された。これは記録の中身を見ずに、ブランチと PR の対応だけで検出できる。
 *
 * **squash マージなので ancestry では判定できない**（main に同じ commit は存在しない）。
 * 判定材料は「そのブランチ名の PR が在るか」だけにする。PR が在れば、open なら進行中、
 * merged なら内容は main に載っており、closed なら捨てる判断が見えている — いずれも
 * **人間の目を一度は通っている**。PR が 1 つも無いものだけが、誰にも見られずに消える。
 *
 * **PR の状態はモデルに持たない。** 上のとおり全状態が同じ結論に落ちるので、持っても
 * 判定に読まれず腐る（「open/merged/closed それぞれで指摘しない」というテストは、状態を
 * 検証しているように見えて素通りする）。「全状態を数える」を保証するのは呼び出し側の
 * 問い合わせ（`state=all`）であって、この関数ではない。
 *
 * これは routine 側の修正の**代わりではない**（routine 自身が PR 作成失敗に気づいて
 * 失敗終了するのが本筋）。routine の挙動がどうであれ外側から取りこぼしを拾う網である。
 *
 * ## PR 作成前の窓を殺さない
 *
 * **push 済みで PR をまだ作っていない**のは完全に正常な状態で、これを指摘すると週次
 * routine が回るたび進行中のブランチが全部並ぶ（2026-08-08 に実際に誤検出した）。
 * FAIL / SKIP で 2 度踏んだ「解決手段のない指摘は狼少年になる」と同じ形なので、
 * **経過時間で分ける** — 本物（`chore/gate-run-20260803`）は 5 日間放置されていた。
 *
 * **日時が分からなければ指摘する側に倒す。** ローカルに無いオブジェクト＝一度も fetch して
 * いないブランチで、まさに #656 が起きた形（クラウド routine が push し、こちらは知らない
 * まま）。「不明だから見逃す」にすると、捕まえたい相手だけが漏れる。
 */

/**
 * PR を持たないブランチ（既定ブランチを除く）。
 *
 * **「PR が 1 件でもあれば良し」にしない。** 無関係な PR が全ブランチを緑にしてしまう。
 */
function branchesWithoutPullRequest(
  branches: readonly RemoteBranch[],
  branchesWithPullRequest: readonly string[],
  defaultBranch: string,
): RemoteBranch[] {
  const withPr = new Set(branchesWithPullRequest);
  return branches.filter((b) => b.name !== defaultBranch && !withPr.has(b.name));
}

/**
 * PR 作成前の正常な窓の内側か。
 *
 * **日時が分からなければ窓の外に倒す**（＝指摘する側）。ローカルに無いオブジェクト＝
 * 一度も fetch していないブランチで、まさに #656 が起きた形。
 *
 * 🔴 **この述語は `evaluateRecordBranches` と `pendingDispatchBranches` の共有物である。**
 * 別々に書くと、片方の条件を変えたときに「どちらにも出ないブランチ」（黙って消える）か
 * 二重計上ができる。排他かつ網羅であることは unit テストが固定している。
 */
function withinGrace(b: RemoteBranch, options: RecordBranchOptions): boolean {
  if (b.tipCommittedAt === undefined) return false;
  const at = Date.parse(b.tipCommittedAt);
  if (Number.isNaN(at)) return false;
  return options.now.getTime() - at < options.graceHours * 3_600_000;
}

export function evaluateRecordBranches(
  branches: readonly RemoteBranch[],
  /** PR を持つブランチ名。**状態は問わない**（上記のとおり全状態が同じ結論に落ちる）。 */
  branchesWithPullRequest: readonly string[],
  defaultBranch: string,
  options: RecordBranchOptions,
): GateRunFinding[] {
  return branchesWithoutPullRequest(branches, branchesWithPullRequest, defaultBranch)
    .filter((b) => !withinGrace(b, options))
    .map((b) => ({
      code: 'orphan_branch' as const,
      severity: 'error' as const,
      message: `リモートブランチ '${b.name}' に紐づく PR がありません。push された内容が ${defaultBranch} に載らないまま失われる可能性があります（#656 の 2026-08-03 がこの形）。中身を確認し、PR を作るか、不要なら削除してください。`,
    }));
}

/**
 * **まだ判定できないブランチ**を返す（push 済み・PR 未作成・猶予内）(#675)。
 *
 * ## なぜ「指摘しない」だけでは足りないのか
 *
 * `evaluateRecordBranches` はこの窓を**指摘しない**。それは正しい ―― PR 作成前は完全に
 * 正常な状態で、赤くすると週次のたびに進行中のブランチが並び、狼少年になる。
 * しかし黙って除外すると、レポートは「指摘はありません」＝**全部片づいた**ように読める。
 *
 * 2026-08-15、まさにこの情報が無いために「クラウド routine は死んだ」と誤診して同じ作業を
 * 再投入し、PR が 2 本（#698 / #699）でき、main に空コミットが残った。
 * **走っているのか止まったのか分からない**という状態が、そう表示されていれば起きなかった。
 *
 * #675 の必須原則「evidence 無しで running/completed へ遷移しない」「無限待機禁止」は、
 * この運用形（人が web セッションで直接作業する）では**受け取り側の表示**として実装される。
 * PR という receipt が無いものを「完了」とも「失敗」とも書かず、**判定保留として数える。**
 *
 * severity は付けない ―― これは指摘ではなく、状態の報告である。
 */
export function pendingDispatchBranches(
  branches: readonly RemoteBranch[],
  branchesWithPullRequest: readonly string[],
  defaultBranch: string,
  options: RecordBranchOptions,
): string[] {
  return branchesWithoutPullRequest(branches, branchesWithPullRequest, defaultBranch)
    .filter((b) => withinGrace(b, options))
    .map((b) => b.name);
}
