/**
 * `scripts/` 配下のスクリプトが**実際に呼ばれているか**を検査する (issue #656)。
 *
 * ## なぜ要るか
 *
 * 2026-08-08、`scripts/evaluate-gate-runs.ts` を呼ぶものが**リポジトリ内に 1 つも無い**
 * ことが判明した。`record_gap`（週次記録の穴）も `orphan_branch`（PR にならなかった push）も
 * 実装しただけで、**人が手で叩いたときしか走っていなかった**。`package.json` に定義があり
 * `docs/` にも書かれていたので、探し方によっては「配線済み」に見える。
 *
 * リポジトリは既に「規律で守るものを機械検証へ移す」を方針にしており
 * （`docs/ai-development-loop.md`）、fitness チェックを 9 件列挙している。だが
 * **「その検査が走っているか」を見るものが無かった**。ここがそのメタ検査。
 *
 * ## 何を「配線」と数えるか
 *
 * **自動で走る経路だけ**を配線とみなす:
 *
 * - `package.json` の scripts
 * - `scripts/quality-gate.sh` / `scripts/record-gate-run.sh`
 * - `scripts/hooks/**`（PreToolUse 等で強制される）
 * - `src/**` / `infra/**` からの import（テストが取り込めばゲートの unit で走る）
 *
 * 🔴 **`docs/**` と `.claude/**` は数えない。** どちらも「人か agent が読んで、そうしようと
 * 決めたときだけ」走る。`evaluate-gate-runs.ts` は docs に書かれていたのに誰も走らせて
 * いなかった — **言及は実行ではない**。数えると、この検査が塞ごうとしている穴が
 * そのまま素通りする。
 *
 * ## 手動実行が正しいものは allowlist へ
 *
 * 実ブラウザや実 AWS が要るもの、リポジトリ外から呼ばれるものは自動化できない。
 * **allowlist に理由付きで載せる**ことで、「うっかり配線し忘れた」と「意図して手動」を
 * 区別する。allowlist のドリフト（もう自動配線されたのに残っている）も検出する
 * — `check-cjk-literals.ts` の例外リストと同じ型。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 自動で走る経路として数えるファイル群。**docs / .claude は含めない**（上記の理由）。 */
const WIRING_SOURCES: readonly string[] = [
  'package.json',
  'scripts/quality-gate.sh',
  'scripts/record-gate-run.sh',
];

/** 再帰的に探索して配線元とみなすディレクトリ。 */
const WIRING_DIRS: readonly string[] = ['scripts/hooks', 'src', 'infra/lib', 'infra/test', 'infra/bin'];

/**
 * 手動実行が正しいスクリプトと、その理由。
 *
 * **理由を書けないものは載せない。** 「なんとなく手動」を許すと、この検査は
 * 単なる形式になる。
 */
export const MANUAL_ONLY_ALLOWLIST: Readonly<Record<string, string>> = {
  'record-gate-run.sh':
    '週次 routine（リポジトリ外）から呼ばれる入口そのもの。リポジトリ内に呼び出し元は無くて正しい。',
  'cloud-setup.sh': 'クラウド開発環境の初期化。人が環境を作るときだけ走る。',
  'url-quality-gate.sh': 'デプロイ済み URL に対する検査。実環境が要るので自動化しない（#65）。',
  'generate-idle-vrma.mjs': 'アセット生成の一回限りツール。成果物は commit 済み。',
  'install_pkgs.sh': 'サンドボックス環境の準備。実行主体は環境側。',
  'demo-studio-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'kiosk-landscape-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'kiosk-visual-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'qr-routing-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'vrm-visual-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
};

/** 検査対象にしないもの（スクリプトではなく共有ライブラリ）。 */
const NOT_A_SCRIPT = new Set(['lib']);

function listScripts(): string[] {
  return fs
    .readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|sh|mjs)$/.test(e.name))
    .map((e) => e.name)
    .filter((n) => !NOT_A_SCRIPT.has(n))
    .sort();
}

/**
 * コメントを落とす（**言及を配線と数えない**ための前処理）。
 *
 * 🔴 **これが無いと、この検査が狙った当のシナリオが素通りする。** 実測: 呼び出し元を
 * すべて消したうえでコメントを配線と数えると、`evaluate-gate-runs.ts` は「配線済み」に
 * 見える — **この検査自身のテストのコメントに `scripts/evaluate-gate-runs.ts` と
 * 書いてあるから**。#656 の再現そのものを見逃す。
 */
export function stripComments(filePath: string, content: string): string {
  const ext = path.extname(filePath);
  if (ext === '.sh') {
    return content
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  }
  if (ext === '.ts' || ext === '.tsx' || ext === '.mjs') {
    return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  return content;
}

/** `scripts/<name>` の形で現れる参照。**1 ファイル 1 パス**で拾う。 */
const SCRIPT_REF = /scripts\/([A-Za-z0-9._-]+)/g;

/**
 * 呼び出し元を 1 回だけ走査して、参照されているスクリプト名の集合を作る。
 *
 * 🔴 **スクリプト名ごとに全ファイルを舐めない。** 最初そう書いたところ
 * O(ファイル数 × スクリプト数) になり、**ゲートの負荷下で 5 秒タイムアウトして落ちた**。
 * 偽の赤を仕込むところだった（このリポジトリは負荷由来の偽の赤を何度も踏んでいる）。
 * 参照は `scripts/<name>` という一定の形なので、1 パスで拾える。
 */
function collectWiredNames(scriptNames: readonly string[]): Set<string> {
  // 拡張子有り／無しの両方から実名へ引けるようにする（TS の import は拡張子を落とす）。
  const byToken = new Map<string, string>();
  for (const n of scriptNames) {
    byToken.set(n, n);
    byToken.set(n.replace(/\.(ts|mjs|sh)$/, ''), n);
  }

  const wired = new Set<string>();
  const scan = (abs: string) => {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    const selfName = path.basename(abs);
    const text = stripComments(abs, fs.readFileSync(abs, 'utf8'));
    for (const m of text.matchAll(SCRIPT_REF)) {
      const name = byToken.get(m[1] ?? '');
      // **自分自身のファイルは配線元に数えない。**
      if (name !== undefined && name !== selfName) wired.add(name);
    }
  };

  for (const rel of WIRING_SOURCES) scan(path.join(ROOT, rel));
  for (const dir of WIRING_DIRS) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') stack.push(full);
        } else if (/\.(ts|tsx|sh|mjs|json)$/.test(e.name)) {
          scan(full);
        }
      }
    }
  }
  return wired;
}

/** 走査結果を使い回す。**2 つのテストが同じ走査を 3 回していた**のが遅さの一因だった。 */
let cachedUnwired: string[] | undefined;

/**
 * 自動経路から**呼び出されていない**スクリプト名を返す（allowlist は適用しない）。
 */
export function findUnwiredScripts(): string[] {
  if (cachedUnwired === undefined) {
    const names = listScripts();
    const wired = collectWiredNames(names);
    cachedUnwired = names.filter((n) => !wired.has(n));
  }
  return cachedUnwired;
}

/** allowlist に載っているのに、もう自動配線されているもの（＝外せる）。 */
export function findStaleAllowlistEntries(): string[] {
  const unwired = new Set(findUnwiredScripts());
  return Object.keys(MANUAL_ONLY_ALLOWLIST)
    .filter((name) => !unwired.has(name))
    .sort();
}
