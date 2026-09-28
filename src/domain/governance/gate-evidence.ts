/**
 * `--full` の実行結果を「PR の head SHA に紐づいた証拠」として読む・判定する・文面にする (#1195)。
 *
 * ## なぜ要るか
 *
 * この repo は GitHub Actions を使わない。マージ前の `--full` は `scripts/quality-gate.sh` を
 * 誰かが回すことで担保され、その green 記録（スタンプ）は `.git` 配下の**ローカル記録**である。
 * Claude が Cloud で `--full` を回しても、**owner からはそれが見えない** ―― 結果として
 * owner が手元の Mac で 1 本ずつ `--full` を回し直していた（2026-09-28、#1181〜#1192 の 12 本）。
 *
 * そこで、ゲートが書き出す証拠ファイル（`scripts/lib/gate-stamp.sh` の `gate_evidence_begin` /
 * `gate_evidence_finish`）を
 * PR のコメントへ載せる。owner は**再実行せずに**、どのコミットを・どこで・どのステップを
 * 通したのかを読んで merge を判断する。参考は 20m61/Nodi の `scripts/ci/publish-verification.mjs`。
 *
 * ## これは「記録」であって「強制」ではない
 *
 * PR コメントはマージを機械的に止めない。強制はローカルの `pr-gate-guard.sh`（スタンプ）と、
 * **owner がこの証拠を読んで merge する**という手順が担う。本文にもそう書く。
 *
 * ## 通す側に倒れないための規則（fail-closed）
 *
 * 次のどれか 1 つでも当たれば PASS と書かない。**判定できなかったものは通さない**:
 *
 * - tier が `full` ではない / ゲートが完走していない（exit が 0 でない・スタンプを書いていない）
 * - 実行計画に `--full` のステップが揃っていない（`--full --no-build` 等）/ 自己テスト用の seam で起動した
 * - 作業ツリーが dirty（開始時・終了時のどちらか。**測れなかった**ときも dirty 扱い）
 * - 実行中に HEAD が動いた
 * - 証拠の SHA が PR の head と違う / PR の head を読めなかった
 * - 実行したステップが 0 件（「見ていない」は「問題なし」ではない）
 * - FAIL / SKIP / 知らない状態のステップが 1 つでもある
 *
 * 🔴 **SKIP を通さないのは意図的。** `quality-gate.sh` の SKIP には「任意ツールが無い」
 * 「検査できなかった（#640）」「docs スコープで入力が変わらない」の 3 種があり、
 * どれも「このコミットでそのステップが green だった」の根拠にはならない。
 * 文書だけの PR で証拠を出すなら `--full --no-skip-docs` で回す。
 */

/** PR コメントを探すための印。**同じ PR には 1 件だけ**置き、以後は更新する。 */
export const GATE_EVIDENCE_MARKER = '<!-- open-reception:gate-evidence -->';

/** 証拠ファイルの書式の版。`scripts/lib/gate-stamp.sh` の `GATE_EVIDENCE_VERSION` と揃える。 */
export const GATE_EVIDENCE_VERSION = 1;

/** summary 行の状態。`NOTE` は情報で、判定に数えない。 */
export type GateStepStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface GateStep {
  readonly status: string;
  readonly label: string;
  /** 括弧内（所要時間や SKIP の理由）。無ければ空。 */
  readonly detail: string;
}

export interface GateEvidence {
  readonly version: number | null;
  readonly tier: string;
  /** ゲートの終了コード。**完走していなければ null**（開始時に書いた仮の記録のまま）。 */
  readonly exitCode: number | null;
  /** green としてスタンプを書いたか。 */
  readonly stamped: boolean;
  readonly headAtStart: string;
  readonly headAtEnd: string;
  /** true / false / null（= 測れなかった）。 */
  readonly dirtyAtStart: boolean | null;
  readonly dirtyAtEnd: boolean | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** 実行環境（`env.<key>=<value>` の行）。表示専用で判定には使わない。 */
  readonly environment: ReadonlyArray<readonly [string, string]>;
  /** 実行計画（`plan.<step>=0|1`）。tier とトグルが解決した結果。 */
  readonly plan: ReadonlyMap<string, string>;
  /** 自己テスト用の seam の値。**空でなければ本物のゲートではない。** */
  readonly selftest: string;
  /** 測る対象を差し替える環境変数のうち、設定されていたものの名前（`override.<NAME>=set`）。 */
  readonly overrides: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<GateStep>;
  readonly notes: ReadonlyArray<string>;
}

const SUMMARY_LINE = /^([A-Z]+) {2}(.+?)(?: {2}\((.*)\))?$/;

function parseBool(value: string | undefined): boolean | null {
  if (value === '0') return false;
  if (value === '1') return true;
  return null;
}

function parseExit(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * 証拠ファイル（`key=value` の行）を読む。
 *
 * **読めない値を既定で埋めない。** 欠けた `dirty_*` は null（測れなかった）、欠けた `exit` は
 * null（完走していない）になり、どちらも `assessGateEvidence` が PASS を拒む。
 * 🔴 同じキーが 2 度現れたら throw する ―― 後勝ち・先勝ちのどちらを選んでも、
 * 追記された 1 行で判定を裏返せてしまう。
 */
export function parseGateEvidence(text: string): GateEvidence {
  const scalar = new Map<string, string>();
  const environment: Array<readonly [string, string]> = [];
  const plan = new Map<string, string>();
  const overrides: string[] = [];
  const steps: GateStep[] = [];
  const notes: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`証拠ファイルの行を読めません: ${JSON.stringify(line.slice(0, 80))}`);
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    if (key === 'summary') {
      const m = SUMMARY_LINE.exec(value);
      if (!m) throw new Error(`summary 行を読めません: ${JSON.stringify(value.slice(0, 80))}`);
      const [, status, label, detail] = m;
      if (status === 'NOTE') notes.push(`${label}${detail ? ` (${detail})` : ''}`);
      else steps.push({ status: status!, label: label!, detail: detail ?? '' });
      continue;
    }
    if (key.startsWith('env.')) {
      environment.push([key.slice(4), value]);
      continue;
    }
    if (key.startsWith('override.')) {
      overrides.push(key.slice(9));
      continue;
    }
    if (key.startsWith('plan.')) {
      if (plan.has(key.slice(5))) throw new Error(`証拠ファイルに ${key} が 2 度あります`);
      plan.set(key.slice(5), value);
      continue;
    }
    if (scalar.has(key)) throw new Error(`証拠ファイルに ${key} が 2 度あります`);
    scalar.set(key, value);
  }

  const version = scalar.get('version');
  return {
    version: version !== undefined && /^\d+$/.test(version) ? Number(version) : null,
    tier: scalar.get('tier') ?? '',
    exitCode: parseExit(scalar.get('exit')),
    stamped: scalar.get('stamped') === '1',
    headAtStart: scalar.get('head_start') ?? '',
    headAtEnd: scalar.get('head_end') ?? '',
    dirtyAtStart: parseBool(scalar.get('dirty_start')),
    dirtyAtEnd: parseBool(scalar.get('dirty_end')),
    startedAt: scalar.get('started_at') ?? '',
    finishedAt: scalar.get('finished_at') ?? '',
    environment,
    plan,
    selftest: scalar.get('selftest') ?? '',
    overrides,
    steps,
    notes,
  };
}

export interface GateEvidenceAssessment {
  readonly passed: boolean;
  readonly reasons: ReadonlyArray<string>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * `--full` が走らせるステップ（`quality-gate.sh` の `--full` の分岐と同じ集合）。
 *
 * 🔴 **「PASS の行しか無い」だけでは足りない。** `--full --no-build --no-infra` は tier を
 * `full` と名乗ったまま build と infra を落とし、SKIP の行すら残さない。seam で起動すれば
 * PASS 1 行だけの証拠になる。実行計画そのものを見る（独立レビュー MAJOR 1）。
 */
export const FULL_PLAN_STEPS: ReadonlyArray<string> = [
  'typecheck',
  'lint',
  'unit',
  'build',
  'infra',
  'e2e',
  'secrets',
  'sast',
  'audit',
  'lighthouse',
  'vrm',
];

function short(sha: string): string {
  return sha === '' ? '(記録なし)' : sha.slice(0, 12);
}

/**
 * この証拠で「PR の head に対して `--full` が green」と言えるかを判定する。
 *
 * 通らない理由は**全部**返す（1 つ目で打ち切らない）。読み手が「他は大丈夫か」を
 * 自分で導き直さなくて済むように。
 */
export function assessGateEvidence(
  evidence: GateEvidence,
  prHeadSha: string | null,
): GateEvidenceAssessment {
  const reasons: string[] = [];

  if (evidence.version !== GATE_EVIDENCE_VERSION) {
    reasons.push(`証拠ファイルの版が ${evidence.version ?? '(不明)'}（期待は ${GATE_EVIDENCE_VERSION}）`);
  }
  if (evidence.tier !== 'full') {
    reasons.push(`tier が ${evidence.tier || '(記録なし)'} —— マージ前の証拠は --full でなければならない`);
  }
  if (evidence.exitCode === null) {
    reasons.push('ゲートが完走していない（終了コードが記録されていない）');
  } else if (evidence.exitCode !== 0) {
    reasons.push(`ゲートが exit ${evidence.exitCode} で終わっている`);
  }
  if (!evidence.stamped) {
    reasons.push('ゲートが green として記録（スタンプ）していない');
  }
  if (evidence.selftest !== '') {
    reasons.push(`自己テスト用の seam（${evidence.selftest}）で起動した実行で、ステップを走らせていない`);
  }
  for (const name of evidence.overrides) {
    reasons.push(`測る対象を差し替える ${name} が設定された実行`);
  }
  const offPlan = FULL_PLAN_STEPS.filter((step) => evidence.plan.get(step) !== '1');
  if (offPlan.length > 0) {
    reasons.push(`--full のステップが実行計画に入っていない: ${offPlan.join(', ')}`);
  }

  if (!FULL_SHA.test(evidence.headAtStart)) {
    reasons.push('検証したコミット（HEAD）が記録されていない');
  } else {
    if (evidence.headAtEnd !== evidence.headAtStart) {
      reasons.push(
        `実行中に HEAD が動いた（開始 ${short(evidence.headAtStart)} → 終了 ${short(evidence.headAtEnd)}）`,
      );
    }
    if (prHeadSha === null) {
      reasons.push('PR の head を読めなかったため、証拠が現在のものか確かめられない');
    } else if (evidence.headAtStart !== prHeadSha) {
      reasons.push(
        `証拠が古い —— 検証したのは ${short(evidence.headAtStart)}、PR の head は ${short(prHeadSha)}`,
      );
    }
  }

  for (const [label, dirty] of [
    ['開始時', evidence.dirtyAtStart],
    ['終了時', evidence.dirtyAtEnd],
  ] as const) {
    if (dirty === null) reasons.push(`${label}の作業ツリーが clean か測れていない`);
    else if (dirty) {
      reasons.push(`${label}の作業ツリーが dirty —— 検証したのはコミットではなく作業ツリー`);
    }
  }

  const executed = evidence.steps.filter((s) => s.status === 'PASS' || s.status === 'FAIL');
  if (executed.length === 0) {
    reasons.push('ステップが 1 つも実行されていない —— 「見ていない」は「問題なし」ではない');
  }
  for (const step of evidence.steps) {
    if (step.status === 'PASS') continue;
    const detail = step.detail ? `（${step.detail}）` : '';
    if (step.status === 'FAIL') reasons.push(`FAIL: ${step.label}${detail}`);
    else if (step.status === 'SKIP') reasons.push(`SKIP: ${step.label}${detail}`);
    else reasons.push(`知らない状態 ${step.status}: ${step.label}${detail}`);
  }

  return { passed: reasons.length === 0, reasons };
}

function cell(text: string): string {
  // 表を壊さない。`|` と改行だけを潰す。
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const STATUS_ICON: Readonly<Record<string, string>> = { PASS: '✅', FAIL: '❌', SKIP: '⏭️' };

/** PR コメントの本文。先頭に `GATE_EVIDENCE_MARKER` を置く。 */
export function renderGateEvidenceComment(
  evidence: GateEvidence,
  assessment: GateEvidenceAssessment,
  prHeadSha: string | null,
): string {
  const lines: string[] = [
    GATE_EVIDENCE_MARKER,
    assessment.passed
      ? `## ✅ \`--full\` PASS（${short(evidence.headAtStart)}）`
      : '## ❌ `--full` の証拠として認めない',
    '',
    '| | |',
    '| --- | --- |',
    `| tier | \`${cell(evidence.tier || '(記録なし)')}\` |`,
    `| 検証したコミット | \`${cell(evidence.headAtStart || '(記録なし)')}\` |`,
    `| PR の head（投稿時） | \`${cell(prHeadSha ?? '(取得できず)')}\` |`,
    `| 作業ツリー | 開始時 ${dirtyText(evidence.dirtyAtStart)} / 終了時 ${dirtyText(evidence.dirtyAtEnd)} |`,
    `| 終了コード | ${evidence.exitCode ?? '(完走していない)'} |`,
    `| 実行時間（UTC） | ${cell(evidence.startedAt || '?')} 〜 ${cell(evidence.finishedAt || '?')} |`,
  ];
  for (const [key, value] of evidence.environment) {
    lines.push(`| ${cell(key)} | ${cell(value)} |`);
  }

  lines.push('', '### ステップ', '', '| | ステップ | 詳細 |', '| --- | --- | --- |');
  for (const step of evidence.steps) {
    lines.push(`| ${STATUS_ICON[step.status] ?? '❓'} ${cell(step.status)} | ${cell(step.label)} | ${cell(step.detail)} |`);
  }
  if (evidence.steps.length === 0) lines.push('| ❓ | — | ステップが 1 つも記録されていない |');
  if (evidence.notes.length > 0) {
    lines.push('', ...evidence.notes.map((n) => `- NOTE: ${n}`));
  }

  if (!assessment.passed) {
    lines.push('', '### PASS と認めない理由', '', ...assessment.reasons.map((r) => `- ${r}`));
  }

  lines.push(
    '',
    '---',
    '',
    '- この repo は GitHub Actions を使いません。これは `./scripts/quality-gate.sh --full` を',
    '  実行環境で回した**記録**で、マージを機械的には止めません。',
    '- 判定は**投稿時点**の PR head に対するものです。以後に push があれば、この証拠は無効です',
    '  （上の「検証したコミット」と PR の現在の head を見比べてください）。',
    '- merge は owner がこの証拠を確認して行います（`docs/loop-workflow.md` 手順 8）。',
    '',
    '---',
    '_Generated by [Claude Code](https://claude.ai/code)_',
  );
  return lines.join('\n');
}

function dirtyText(value: boolean | null): string {
  if (value === null) return '**測れていない**';
  return value ? '**dirty**' : 'clean';
}
