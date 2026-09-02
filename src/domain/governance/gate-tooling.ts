/**
 * 品質ゲートの任意ツール有無を、純関数で名指しする (#838)。
 *
 * ## なぜ
 *
 * `quality-gate.sh` は任意ツール未導入を SKIP する（`--strict` 無しなら FAIL にならない）。
 * SessionStart / install が欠けに気づかないと、**マージゲートが黙って弱くなる**。
 * 「入っているが動かない」（例: Playwright chromium バイナリ欠落）は SKIP にもならず、
 * e2e が 1ms で全滅してから初めて分かる。
 *
 * I/O（`command -v` / パス存在）は呼び出し側が集め、この module は観測結果だけを解釈する
 * （`command-preflight.ts` と同じ層分け）。
 *
 * ## AC6 について
 *
 * semgrep のルールセットは #841 でリポジトリ内へ固定済み（`scripts/sast.sh`）。
 * ここが扱うのは「semgrep バイナリそのものの有無」だけ。
 */

/** ゲートが任意扱いする道具。欠けると対応ステップが SKIP または検査不能になる。 */
export const GATE_OPTIONAL_TOOLS = [
  'gitleaks',
  'semgrep',
  'aws',
  'playwrightChromium',
] as const;

export type GateOptionalTool = (typeof GATE_OPTIONAL_TOOLS)[number];

export type GateToolObservation = Readonly<Record<GateOptionalTool, boolean>>;

/** 欠落ツールを安定順で返す。キー欠落も欠落扱い（判定不能を PASS に倒さない）。 */
export function missingGateTools(observed: Partial<GateToolObservation>): GateOptionalTool[] {
  return GATE_OPTIONAL_TOOLS.filter((id) => observed[id] !== true);
}

export function presentGateTools(observed: Partial<GateToolObservation>): GateOptionalTool[] {
  return GATE_OPTIONAL_TOOLS.filter((id) => observed[id] === true);
}

/**
 * e2e / VRM 実描画は Playwright の chromium バイナリが要る。
 * CLI パッケージだけ入っていても `Executable doesn't exist` で全件 1ms 落ちになる。
 */
export function playwrightChromiumReady(observed: Partial<GateToolObservation>): boolean {
  return observed.playwrightChromium === true;
}

/**
 * SessionStart / install 末尾へ出す固定テンプレ。自由文スロットを持たない。
 *
 * - 欠けがあるときだけ先頭に警告行を足す（全部揃っていれば静かに一覧だけ）
 * - gitleaks 欠落時は push-secret-guard が素通しする事実を同じ塊で名指しする (#838 AC3)
 */
export function formatGateToolSessionReport(observed: Partial<GateToolObservation>): string[] {
  const missing = missingGateTools(observed);
  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(`⚠️ gate-tooling: missing ${missing.join(', ')}`);
  } else {
    lines.push('gate-tooling: all optional tools present');
  }
  for (const id of GATE_OPTIONAL_TOOLS) {
    const state = observed[id] === true ? 'present' : 'MISSING';
    lines.push(`  ${id}: ${state}`);
  }
  if (observed.gitleaks !== true) {
    lines.push(
      '  note: gitleaks MISSING → push-secret-guard will SKIP secret scan (push allowed unless OPEN_RECEPTION_STRICT_SECRET_SCAN=1)',
    );
  }
  if (observed.playwrightChromium !== true) {
    lines.push(
      '  note: playwrightChromium MISSING → --full e2e/vrm cannot run (npx playwright install chromium)',
    );
  }
  return lines;
}

/** quality-gate が e2e 前に出す 1 行理由（skip_unverified の reason にそのまま載せる）。 */
export function playwrightChromiumMissingReason(): string {
  return 'playwright chromium not installed (npx playwright install chromium)';
}
