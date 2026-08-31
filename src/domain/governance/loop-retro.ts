/**
 * ループの**外側**（規約そのものを改善するループ）の点検 (issue #424)。
 *
 * ## なぜ要るか
 *
 * このリポジトリには内側ループ（Issue → TDD → ゲート → PR → マージ）が既に在り、
 * 失敗から得た教訓は `.claude/rules/opus5-autonomous-loop.md` と `CLAUDE.md` に
 * `> 由来: <日付> / #<issue>` の形で書き足されてきた。だが外側は 3 点欠けていた:
 *
 * 1. **版が無い**ので、ある周回がどの規約リビジョンの下で走ったか帰属できない。
 *    帰属できないと「その教訓を入れてから実際に再発が減ったか」を測れない。
 * 2. **上限が無い**ので append-only に積み上がる。古い教訓が誤りでも消えず、
 *    規約自体がコンテキスト予算を食う。
 * 3. **「今回は変更なし」を記録する場所が無い**ので、「回っていない」と
 *    「回したが変えるに値しなかった」が区別できない。
 *
 * ここはその 3 点を機械検証へ移す純関数。ファイル読み込みと表示は
 * `scripts/loop-retro.ts`、改善そのものの手順は `.claude/skills/loop-retro/SKILL.md`。
 *
 * ## ゲートに入れるものと入れないもの
 *
 * **構造の検査（上限・帰属・版マーカーの有無）だけがゲートに入る** —— ファイルを読めば
 * 決まるので偽陽性が無い。**間隔の検査（`never_run` / `stale`）はゲートに入れない**：
 * 運用が止まっている間ずっと開発者のローカルゲートが赤くなり、override が習慣化する
 * （`evaluate-gate-runs.ts` と同じ判断 / `docs/ai-development-loop.md` §9）。
 */

/** 教訓の上限。Warp の improver skill と同じ 15 件。超えたら統合か剪定を促す。 */
export const GUIDELINE_BUDGET = 15;

/** これを超えて外側ループが回っていなければ「止まっている」とみなす（日）。 */
const STALE_AFTER_DAYS = 21;

/** 規約ファイルに埋める版マーカー。改善スキルがここを上げる。 */
const REVISION_MARKER = /<!--\s*loop-rules-revision:\s*(\d+)\s*-->/;

export type LearnedGuideline = {
  /** 直近の見出し（どの規律に属する教訓か）。 */
  heading: string;
  /** `由来: 2026-08-26 / ...` の日付。読めなければ undefined。 */
  date?: string;
  /** 由来に現れる issue 番号。 */
  issues: number[];
  /** 由来に現れる PR 番号。 */
  pulls: number[];
  /** 由来ブロックの生文字列（証拠としてそのまま見せる）。 */
  raw: string;
  /** ファイル内の行番号（1 始まり）。指摘を人が引けるようにする。 */
  line: number;
};

export type RetroRun = {
  /** 実行時刻（`2026-08-31T00:00Z`）。 */
  at: string;
  revisionFrom?: number;
  revisionTo?: number;
  /** `UPDATED` = 規約を変えた / `NO_CHANGE` = 回したが変えるに値しなかった。 */
  result: 'UPDATED' | 'NO_CHANGE';
  note: string;
};

export type LoopRetroFinding = {
  code:
    | 'never_run'
    | 'stale'
    | 'over_budget'
    | 'missing_provenance'
    | 'revision_drift'
    | 'revision_unmeasured';
  severity: 'error' | 'warning';
  message: string;
};

/**
 * 規約ファイルの版を読む。
 *
 * 🔴 **マーカーが無いときに 1 や 0 へ落とさない。** 「版が無い」を「版 1」と読むと、
 * 測れていないものを測れたことにしてしまう（#717 と同じ 3 状態の扱い）。
 */
export function parseRulesRevision(markdown: string): number | undefined {
  const m = REVISION_MARKER.exec(markdown);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * `> 由来: ...` で始まる引用ブロックを教訓として抜く。
 *
 * **継続行まで 1 件に畳む。** このリポジトリの由来ブロックは複数行にわたるので、
 * 行ごとに数えると 1 つの教訓が上限を何件も食う。
 */
export function parseLearnedGuidelines(markdown: string): LearnedGuideline[] {
  const lines = markdown.split('\n');
  const guidelines: LearnedGuideline[] = [];
  let heading = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h !== null) {
      heading = (h[1] ?? '').trim();
      continue;
    }
    if (!/^>\s*由来\s*:/.test(line)) continue;
    const block: string[] = [line];
    let j = i + 1;
    while (j < lines.length && /^>/.test(lines[j] ?? '')) {
      block.push(lines[j] ?? '');
      j += 1;
    }
    const raw = block.join('\n');
    guidelines.push({
      heading,
      date: /(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1],
      issues: refNumbers(raw, false),
      pulls: refNumbers(raw, true),
      raw,
      line: i + 1,
    });
    i = j - 1;
  }
  return guidelines;
}

/**
 * `#123` 参照を拾う。`PR #123` と書かれたものだけを PR、それ以外を issue とみなす。
 *
 * 本リポジトリの由来は `#788（PR #804）` の形で両方を書く。前置きを見ずに数えると
 * **PR 番号が issue として二重に数えられ**、帰属の検査が空虚に通る。
 */
function refNumbers(raw: string, wantPull: boolean): number[] {
  const out: number[] = [];
  const re = /(PR\s*)?#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const isPull = m[1] !== undefined;
    if (isPull === wantPull) out.push(Number(m[2]));
  }
  return out;
}

/** EXAMPLE 行は実データではない（`gate-runs.md` と同じ扱い）。 */
function isExampleRow(cells: readonly string[]): boolean {
  return cells.some((c) => c.includes('EXAMPLE'));
}

/**
 * `docs/loop-retro.md` から実行記録を抜く。**新しい順**で返す。
 *
 * 日時列の体裁を満たす行だけを実データとして拾う（説明表やヘッダに釣られない）。
 */
export function parseRetroRuns(markdown: string): RetroRun[] {
  const runs: RetroRun[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    const at = cells[0] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(at)) continue;
    if (isExampleRow(cells)) continue;
    const result = (cells[4] ?? '').toUpperCase();
    if (result !== 'UPDATED' && result !== 'NO_CHANGE') continue;
    const rev = /(\d+)\s*(?:→|->)\s*(\d+)/.exec(cells[1] ?? '');
    runs.push({
      at,
      revisionFrom: rev === null ? undefined : Number(rev[1]),
      revisionTo: rev === null ? undefined : Number(rev[2]),
      result,
      note: cells[5] ?? '',
    });
  }
  return runs.sort((a, b) => b.at.localeCompare(a.at));
}

export type LoopRetroInput = {
  guidelines: readonly LearnedGuideline[];
  runs: readonly RetroRun[];
  /** 規約ファイルの現在の版。**読めなかったときは undefined**（1 に落とさない）。 */
  rulesRevision: number | undefined;
  now: Date;
};

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
}

export function evaluateLoopRetro(input: LoopRetroInput): LoopRetroFinding[] {
  const findings: LoopRetroFinding[] = [];
  const { guidelines, runs, rulesRevision, now } = input;

  if (guidelines.length > GUIDELINE_BUDGET) {
    findings.push({
      code: 'over_budget',
      severity: 'error',
      message:
        `教訓が ${guidelines.length} 件で上限 ${GUIDELINE_BUDGET} を超えています。` +
        '重なるものを統合するか、証拠の弱いものを剪定してください（増やし続けると規約自体が読まれなくなる）。',
    });
  }

  for (const g of guidelines) {
    // **日付だけでは帰属にならない。** どの周回の産物か引けなければ、
    // 「その教訓を入れてから再発したか」を後から測れない。
    if (g.date !== undefined && (g.issues.length > 0 || g.pulls.length > 0)) continue;
    findings.push({
      code: 'missing_provenance',
      severity: 'error',
      message:
        `${RULES_LABEL}:${g.line}（${g.heading || '見出しなし'}）の教訓に帰属がありません。` +
        '`> 由来: <YYYY-MM-DD> / #<issue>（PR #<n>）` の形で、どの周回の産物かを書いてください。',
    });
  }

  if (rulesRevision === undefined) {
    // 🔴 **「触れていない」と「測れていない」を混ぜない (#717)。** 版が読めないときは
    // drift を「無し」と断定せず、測れていないことを出す。
    findings.push({
      code: 'revision_unmeasured',
      severity: 'warning',
      message:
        '規約ファイルに版マーカー（`<!-- loop-rules-revision: N -->`）がありません。' +
        '**版の食い違いは「無い」のではなく「測れていません」。**',
    });
  } else if (runs.length > 0 && runs[0]?.revisionTo !== undefined && runs[0].revisionTo !== rulesRevision) {
    findings.push({
      code: 'revision_drift',
      severity: 'warning',
      message:
        `規約は版 ${rulesRevision} ですが、台帳の直近は版 ${runs[0].revisionTo} で終わっています。` +
        '外側ループを通さずに教訓が足されたか、実行の記録が漏れています。',
    });
  }

  if (runs.length === 0) {
    // **「仕組みは作ったが回っていない」を最優先で可視化する** (#656 と同じ型)。
    findings.push({
      code: 'never_run',
      severity: 'error',
      message:
        '外側ループ（`/loop-retro`）の実行記録が 1 件もありません。' +
        'スキルを置いただけでは回りません（`docs/loop-retro.md` に記録が要ります）。',
    });
    return findings;
  }

  const latest = runs[0];
  const age = daysBetween(new Date(latest?.at ?? ''), now);
  if (age > STALE_AFTER_DAYS) {
    findings.push({
      code: 'stale',
      severity: 'warning',
      message:
        `外側ループの直近実行が ${Math.floor(age)} 日前（${latest?.at}）で、` +
        `${STALE_AFTER_DAYS} 日を超えています。内側ループだけが回り、規約が更新されていません。`,
    });
  }

  return findings;
}

/** 指摘メッセージで教訓の場所を指すときのラベル。 */
const RULES_LABEL = '.claude/rules/opus5-autonomous-loop.md';
