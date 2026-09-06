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

/**
 * **その道具を要するテストが「不在」で落ちたとき**に、原因へ到達できる 1 本の文字列。
 *
 * ## なぜ要るか（2026-09-06 に実際に踏んだ）
 *
 * gitleaks が入っていないクラウドセッションで `tests/hooks/push-secret-guard.test.ts` が
 * **14 件赤**になった。ところが個々の失敗は `expected +0 to be 2` で、**gitleaks という語が
 * 出力に一度も現れない**。フックは gitleaks が無いと（既定で）警告して素通しするため
 * exit 0 になり、「ブロックされるはず」の assertion が全部落ちる —— 症状は「フックが壊れた」
 * ようにしか見えないが、実際は**環境に道具が無いだけ**である。
 *
 * 道具が無言で欠けるのは `scripts/cloud-setup.sh` が install を全部 `|| true` で握り潰す
 * ためで、これは意図的（非ゼロ終了するとセッションごと起動しない）。つまり
 * **「握り潰しをやめる」は取れない**。取れるのは、欠けた結果として落ちたテストから
 * 原因へ辿れるようにすることだけである。
 *
 * `formatGateToolSessionReport` は SessionStart で既に欠落を名指ししているが、
 * **赤くなったテストの側からその報告へ辿る導線が無かった**。この文字列がその導線になる。
 */
export function missingToolTestPrerequisiteMessage(tool: GateOptionalTool): string {
  // 🔴 **`cloud-setup.sh` を `scripts/` 付きのパスとして書かない。** `check-script-wiring.ts` の
  // `SCRIPT_REF` は `scripts/<name>` を配線とみなすので、ここに完全パスを書くと
  // 「もう自動配線された」と誤判定され、allowlist の「なぜ手動なのか」という記録が
  // 消える方向へ倒れる（#681 と同型。実際にこの関数を書いた時点で一度落とした）。
  // `execution-lane.ts` が同じ理由で同じ書き方をしている。
  return [
    `${tool} が PATH にありません。このテストは ${tool} の実挙動を検証するため、不在のままでは結果に意味がありません（不在時は検査が素通りし、無関係に見える assertion が落ちます）。`,
    `無言で欠ける理由: cloud-setup.sh（\`scripts/\` 配下）は install を全て \`|| true\` で握り潰します（非ゼロ終了するとセッションごと起動しないため）。`,
    `確認: セッション開始時の gate-tooling 報告（"gate-tooling: missing ..."）に ${tool} が挙がっていないか。`,
    `復旧: cloud-setup.sh の ${tool} 導入部分を手で実行する（docs/cloud-dev-environment.md）。`,
  ].join('\n');
}

/** quality-gate が e2e 前に出す 1 行理由（skip_unverified の reason にそのまま載せる）。 */
export function playwrightChromiumMissingReason(): string {
  return 'playwright chromium not installed (npx playwright install chromium)';
}
