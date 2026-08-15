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
 * - `.claude/settings.json` の **`hooks` ブロックだけ**（下記）
 *
 * 🔴 **`docs/**` と `.claude` 配下の散文は数えない。** どちらも「人か agent が読んで、
 * そうしようと決めたときだけ」走る。`evaluate-gate-runs.ts` は docs に書かれていたのに
 * 誰も走らせていなかった — **言及は実行ではない**。数えると、この検査が塞ごうとしている
 * 穴がそのまま素通りする。
 *
 * 🔴 **例外は `.claude/settings.json` の `hooks` だけ (#681)。** これは散文ではなく
 * **ハーネスが強制実行する**宣言なので、`package.json` の scripts と同じ自動経路である。
 * 数えないと `scripts/hooks/**` が「未配線」に見え、allowlist へ嘘の理由を書く羽目になる。
 * **同じファイルの `permissions.allow` は数えない** — あれは「実行してよい」であって
 * 「実行される」ではない。ファイル全体を正規表現で舐めるのではなく `hooks` だけを
 * 構造的に取り出すのはこのためである（`extractHookCommands`）。
 *
 * ## 配線は推移しない (#681)
 *
 * 🔴 **`MANUAL_ONLY_ALLOWLIST` に載っているスクリプトは、配線元として数えない。**
 * 以前は `aws-cloud-deploy.sh` が `WIRING_SOURCES` と allowlist の**両方**に載っており、
 * 「自動では一度も走らないスクリプトから呼ばれているだけ」で配線済みと数えられた。
 * 実際 `url-quality-gate.sh` がこの経路で allowlist から外れ、そこに書かれていた理由
 * （実環境が要るので自動化しない / #65）が記録として失われた。
 * **手動でしか走らないものから呼ばれることは、自動で走ることを意味しない。**
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

/**
 * 自動で走る経路として数えるファイル群。**docs / .claude の散文は含めない**（上記の理由）。
 *
 * 🔴 **`scripts/aws-cloud-deploy.sh` はここに載せない (#681)。** 以前は載っていたが、
 * 同時に `MANUAL_ONLY_ALLOWLIST` にも載っている（クラウドセッションから人が叩く入口）。
 * 自動では一度も走らないものを配線元に数えると、そこから呼ばれるだけのスクリプトが
 * 配線済みに見える。仮に書き戻しても `collectWiredNames` が allowlist 側で弾くが、
 * **矛盾した宣言を残さない**ためにここからも外す。
 */
const WIRING_SOURCES: readonly string[] = [
  'package.json',
  'scripts/quality-gate.sh',
  'scripts/record-gate-run.sh',
];

/**
 * 再帰的に探索して配線元とみなすディレクトリ。
 *
 * 🔴 **トップレベルの `tests/` は含めない (#681 で一度足して、取り消した)。**
 * `tests/hooks/aws-preflight.test.ts` は実際に `scripts/aws-preflight.ts` を CLI として
 * 起動しており「ゲートのたびに走っている」のは事実である。しかし**それを配線と数えると
 * この検査は #656 を検出できなくなる** —— #656 の失敗は「検出器は作られ、テストもあり、
 * しかしワークフローからは誰も呼んでいなかった」だった。
 * **テストが在ることは、使われていることではない。**
 *
 * `src/**` を数えるのは、そこからの import が「本番の消費者がいる」ことを意味するため
 * （co-located のテストはその副産物）。トップレベル `tests/` は消費者ではなく検証者なので
 * 区別する。
 */
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
  'generate-idle-vrma.mjs': 'アセット生成の一回限りツール。成果物は commit 済み。',
  // `install_pkgs.sh` は #681 で allowlist から外した。`.claude/settings.json` の
  // SessionStart フックが実際に叩いており、**手動ではなく自動で走る**。
  // hooks を配線元に数えるようにして初めて、この誤分類が見えた。
  'demo-studio-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'kiosk-landscape-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'kiosk-visual-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'qr-routing-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'vrm-visual-check.mjs': '実ブラウザが要る（visual-checks skill から手動）。',
  'aws-cloud-deploy.sh':
    'クラウドセッション / routine から呼ぶ入口そのもの。リポジトリ内に呼び出し元は無くて正しい。',
  'aws-issue-credentials.sh':
    '人間がローカル Mac の Admin 環境でデプロイ窓を開けるときだけ走る（値をリポジトリに残さない）。',
  // ---- 以下は #681 で追加。すべて `aws-cloud-deploy.sh`（manual-only の入口）からのみ
  // 呼ばれる。以前は「manual-only の入口から呼ばれている」ことで配線済みと数えられており、
  // 手動である理由がどこにも記録されていなかった。
  //
  // 🔴 **「テストが在る」を理由に外さないこと。** `aws-preflight.ts` と
  // `aws-stack-selection.ts` には `tests/hooks/**` があり CLI として起動もされるが、
  // それは検証であって使用ではない。#656 の失敗そのもの（作られ、テストもされ、
  // ワークフローからは誰も呼んでいない）を見逃す数え方はしない。
  'url-quality-gate.sh':
    'デプロイ済みの実 URL に対して走らせるもの。実環境が要るので自動化しない（#65）。',
  'aws-preflight.ts':
    'デプロイ窓の中でしか意味を持たない preflight 判定 CLI。実 AWS の観測を入力に取るため自動では走らせない。',
  'aws-command-preflight.ts':
    'deploy wrapper が AWS を呼ぶ前に依存コマンドの有無を確かめる CLI。デプロイ時にしか走らない。',
  'aws-deploy-context.ts':
    'デプロイに必須の CDK context を解決する CLI。`diff` / `deploy` の実行時にしか意味が無い。',
  'aws-stack-selection.ts':
    '`--only` を解決してデプロイ対象を決める CLI。`diff` / `deploy` の実行時にしか意味が無い。',
};

/**
 * 検査対象にしないディレクトリ（`scripts/` からの相対）。
 *
 * - `lib` … 呼ばれるべきスクリプトではなく、他のスクリプトが source する共有ライブラリ
 * - `aws-policies` … IAM ポリシー JSON。データであってスクリプトではない
 *   （拡張子フィルタでも落ちるが、意図を明示するために挙げておく）
 */
const NOT_A_SCRIPT_DIR = new Set(['lib', 'aws-policies']);

/**
 * 検査対象のスクリプトを `scripts/` からの**相対パス**で返す（例: `hooks/pr-gate-guard.sh`）。
 *
 * 🔴 **サブディレクトリまで再帰する (#681 defect 1)。** 以前は `scripts/` 直下しか見て
 * おらず、`scripts/hooks/**` は配線元としては走査されるのに**検査対象には一度も
 * 入っていなかった**。誰かが `scripts/foo/bar.ts` を作った瞬間、この検査から静かに外れる。
 *
 * basename ではなく相対パスを鍵にするのは、別ディレクトリの同名スクリプトを取り違えないため。
 */
export function listScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        if (!NOT_A_SCRIPT_DIR.has(rel) && e.name !== 'node_modules') walk(path.join(dir, e.name), rel);
      } else if (e.isFile() && /\.(ts|sh|mjs)$/.test(e.name)) {
        out.push(rel);
      }
    }
  };
  walk(path.join(ROOT, 'scripts'), '');
  return out.sort();
}

/**
 * `.claude/settings.json` の `hooks` ブロックに現れる `command` 文字列を返す。
 *
 * 🔴 **`hooks` だけを構造的に取り出す。** ファイル全体を舐めると `permissions.allow`
 * （「実行してよい」であって「実行される」ではない）まで配線と数えてしまい、
 * `install_pkgs.sh` のような手動スクリプトが名前を書かれているだけで配線済みに見える。
 *
 * 形は `hooks: { <Event>: [ { matcher, hooks: [ { type, command } ] } ] }`。
 * 未知の形・欠落に対しては黙って空を返す（設定が無い環境でも壊れない）。
 */
export function extractHookCommands(settings: unknown): string[] {
  const commands: string[] = [];
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (typeof hooks !== 'object' || hooks === null) return commands;
  for (const matchers of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const entry of matchers) {
      const inner = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown } | null)?.command;
        if (typeof cmd === 'string') commands.push(cmd);
      }
    }
  }
  return commands;
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

/**
 * `scripts/<name>` の形で現れる参照。**1 ファイル 1 パス**で拾う。
 *
 * `/` を許すのは、サブディレクトリのスクリプト（`scripts/hooks/pr-gate-guard.sh`）を
 * 相対パスとして拾うため (#681)。許さないと `scripts/hooks` までしか一致せず、
 * サブディレクトリのスクリプトは**どう書かれていても永久に未配線**に見える。
 */
const SCRIPT_REF = /scripts\/([A-Za-z0-9._/-]+)/g;

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

  /** `<abs>` が `scripts/` 配下なら、その相対パス（= 検査対象の鍵）を返す。 */
  const scriptsRel = (abs: string): string | null => {
    const rel = path.relative(path.join(ROOT, 'scripts'), abs);
    return rel !== '' && !rel.startsWith('..') ? rel.split(path.sep).join('/') : null;
  };

  const wired = new Set<string>();

  /** テキストから参照を拾う。`selfRel` は自己参照を除くための、自分自身の鍵。 */
  const scanText = (text: string, selfRel: string | null): void => {
    for (const m of text.matchAll(SCRIPT_REF)) {
      const name = byToken.get(m[1] ?? '');
      // **自分自身のファイルは配線元に数えない。**
      if (name !== undefined && name !== selfRel) wired.add(name);
    }
  };

  const scan = (abs: string) => {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    const selfRel = scriptsRel(abs);
    // 🔴 **手動でしか走らないスクリプトは配線元にしない (#681 defect 2)。**
    // 「自動では一度も走らないものから呼ばれている」ことは配線ではない。
    if (selfRel !== null && selfRel in MANUAL_ONLY_ALLOWLIST) return;
    scanText(stripComments(abs, fs.readFileSync(abs, 'utf8')), selfRel);
  };

  for (const rel of WIRING_SOURCES) scan(path.join(ROOT, rel));

  // `.claude/settings.json` は `hooks` ブロックだけを配線元に数える（`permissions` は数えない）。
  const settingsPath = path.join(ROOT, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      scanText(extractHookCommands(settings).join('\n'), null);
    } catch {
      // 壊れた JSON でこの検査ごと落とさない。hooks 経由の配線が数えられなくなるだけで、
      // 影響は「未配線として出る」＝安全側。
    }
  }

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
