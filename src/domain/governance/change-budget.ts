/**
 * 1 ループあたりの変更量上限と kill switch (issue #424 増分 4)。
 *
 * `docs/ai-development-loop.md` §9 のチェックリスト
 * 「kill switch と 1 ループあたりの変更行数 / ファイル数 / コスト上限」に対応する純関数。
 * I/O を持たない（git・fs・env の読み取りは `scripts/change-budget.ts` が行う）。
 *
 * ## 止める資格が違うので扱いを分ける
 *
 * | | 何を検出するか | ゲートでの扱い | なぜ |
 * | --- | --- | --- | --- |
 * | kill switch | **人間が明示的に armed にした**こと | **FAIL** | 偽陽性が原理的に無い。止めると決めた人が居る |
 * | 変更量上限 | 変更が既定の目安を超えたこと | **報告のみ** | 大きい変更が自動的に悪いわけではない |
 *
 * 変更量で FAIL させると、依存更新・生成物・大きなリファクタのたびに赤くなり、**override が
 * 習慣化する**。それは change-risk（増分 3）で避けたのと同じ失敗——「赤を無視する習慣」を
 * 作る方が、たまに大きい PR が素通りするより危険。ここが担うのは**可視化と自覚**であり、
 * 判断は人間が行う（PR テンプレートの該当欄で表明する）。
 *
 * ## 既定値の根拠
 *
 * `docs/loop-queue.md` の wave 表に並ぶ実際の周回はおおむね 5〜15 ファイル / 数百行に収まる。
 * 上限はそれを咎めるためではなく、**暴走（意図しない全域書き換え・生成物の巻き込み）を
 * 見えるようにする**ためのものなので、通常の周回では鳴らない水準に置く。
 */

/** 変更量の上限。超えても FAIL しない（報告のみ）。 */
export type ChangeBudgetLimits = {
  maxFiles: number;
  /** 追加 + 削除の合計。片方だけを見ると「全消しして書き直し」を見逃す。 */
  maxChangedLines: number;
};

/**
 * 既定の上限。**通常の周回では鳴らない水準**（暴走の検出が目的で、大きさの禁止ではない）。
 */
export const DEFAULT_CHANGE_BUDGET: ChangeBudgetLimits = {
  maxFiles: 40,
  maxChangedLines: 1500,
};

/** git から集めた変更量。 */
export type ChangeStat = {
  files: number;
  insertions: number;
  deletions: number;
};

/** 超過した軸。両方超えたら両方入る（片方で打ち切らない）。 */
export type BudgetAxis = 'files' | 'lines';

export type ChangeBudgetVerdict = {
  files: number;
  /** 追加 + 削除。 */
  changedLines: number;
  limits: ChangeBudgetLimits;
  exceeded: readonly BudgetAxis[];
  withinBudget: boolean;
};

/**
 * 変更量を上限と突き合わせる。**境界は含む**（ちょうど上限は超過ではない）。
 */
export function evaluateChangeBudget(
  stat: ChangeStat,
  limits: ChangeBudgetLimits,
): ChangeBudgetVerdict {
  const changedLines = stat.insertions + stat.deletions;
  const exceeded: BudgetAxis[] = [];
  if (stat.files > limits.maxFiles) exceeded.push('files');
  if (changedLines > limits.maxChangedLines) exceeded.push('lines');
  return {
    files: stat.files,
    changedLines,
    limits,
    exceeded,
    withinBudget: exceeded.length === 0,
  };
}

/** kill switch の入力（解決済みシグナル）。読み取りは呼び出し側が行う。 */
export type KillSwitchSignal = {
  /** env の値（`OPEN_RECEPTION_LOOP_HALT`）。未設定は undefined。 */
  env?: string | undefined;
  /** 停止ファイルの中身。ファイルが無いときは undefined（**空文字とは区別する**）。 */
  fileContent?: string | undefined;
};

export type KillSwitchVerdict = {
  halted: boolean;
  /** 何が立っていたか。停止していないときは null。 */
  source: 'file' | 'env' | null;
  /** 人が書いた理由（停止ファイルの中身）。無ければ null。 */
  reason: string | null;
};

/** env の偽値。未設定・空文字・`0`・`false` は「立っていない」。 */
const FALSY_ENV: ReadonlySet<string> = new Set(['', '0', 'false']);

/**
 * ループの緊急停止が armed かを判定する。
 *
 * **ファイルを優先する** — env は一時的・不可視なのに対し、停止ファイルは人が理由を書いて
 * 置いたものなので情報量が多い。理由は運用者が読むためのもので、解除条件ではない
 * （理由が空でも止まる。「理由が書いていないから続行してよい」は事故になる）。
 */
export function resolveKillSwitch(signal: KillSwitchSignal): KillSwitchVerdict {
  if (signal.fileContent !== undefined) {
    const reason = signal.fileContent.trim();
    return { halted: true, source: 'file', reason: reason === '' ? null : reason };
  }
  if (signal.env !== undefined && !FALSY_ENV.has(signal.env.trim().toLowerCase())) {
    return { halted: true, source: 'env', reason: null };
  }
  return { halted: false, source: null, reason: null };
}
