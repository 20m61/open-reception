/**
 * kiosk 配下の「生 CJK 文字列リテラル」検出 (issue #327)。
 *
 * 目的: 多言語モード対応の kiosk 画面に、i18n カタログを経由しない日本語（等の CJK）
 * ハードコード文言が新規に紛れ込むことを構造的に検出する。
 *
 * 方針:
 *   - TypeScript Compiler API で AST を解析し、**文字列リテラル / テンプレートリテラル /
 *     JSX テキスト**だけを対象にする（コメントは対象外＝日本語コメントは許容する）。
 *   - `CJK_EXCEPTION_ALLOWLIST` に載っているファイルは対象外（まだ i18n 移行前の既存
 *     kiosk コンポーネント、または構造的に visitor 向け多言語対象外のファイル）。
 *   - allowlist に無いファイル（= checkout/**、signage/SignageDisplay.tsx、将来追加される
 *     新規ファイル）は一致が 1 件でもあれば違反として報告する＝新規の翻訳漏れを検出する。
 *   - 走査対象は `src/components/kiosk` と `src/app/kiosk`（受付端末が持つ全ルート）の
 *     両方（#327 2nd increment）。従来は components/kiosk のみで、`enroll/page.tsx` 等の
 *     app router ページが検出対象外になっていた棚卸し漏れを閉じる。
 *
 * 制約: allowlist 済みファイルへの「新規」CJK 追加までは検出しない（ファイル単位の
 * allowlist のため）。行単位の diff ベース検出は将来課題（#327 follow-up、レポートに明記）。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** CJK 判定: ひらがな・カタカナ・CJK 統合漢字・ハングル音節。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

export interface CjkViolation {
  /** リポジトリルートからの相対パス（POSIX 区切り）。 */
  file: string;
  line: number;
  text: string;
}

const REPO_ROOT = path.resolve(__dirname, '..');
/**
 * 走査対象ルート (#327 2nd increment で app router ページも追加)。
 * kiosk が持つ全ルート = 部品 (`src/components/kiosk`) + ページ (`src/app/kiosk`)。
 */
const DEFAULT_ROOTS = [
  path.join(REPO_ROOT, 'src/components/kiosk'),
  path.join(REPO_ROOT, 'src/app/kiosk'),
];

/**
 * 例外リスト（未移行の既存 kiosk コンポーネント、リポジトリルートからの相対パス）。
 * #327 では退館チェックアウト導線（checkout/** と KioskFlow.tsx の CheckoutLink）と
 * 待機サイネージ（signage/SignageDisplay.tsx、SignageWaitingView）を i18n 化した。
 * 残りは別トラック/follow-up で棚卸しする既存債務であり、ここに明示する。
 * checkout/** と signage/SignageDisplay.tsx は意図的にここへ追加しない（例外なしで完全検証する）。
 *
 * app router ページ 2 件は構造的に visitor 向け多言語の対象外のため allowlist に含める:
 *   - `enroll/page.tsx`: 端末の管理発行 URL/QR によるエンロール（一度きりの端末設定）。
 *     来訪者が言語を選ぶより前の、担当者/設置作業者向けの端末プロビジョニング画面であり
 *     「待機→受付→退館」の来訪者導線には含まれない。
 *   - `layout.tsx`: ブラウザタブタイトルのメタデータのみ（画面本文ではない）。admin/platform
 *     と同様にタブタイトルは日本語運用に統一しており、来訪者が閲覧する画面コンテンツではない。
 */
export const CJK_EXCEPTION_ALLOWLIST: readonly string[] = [
  'src/components/kiosk/CheckinFlow.tsx',
  'src/components/kiosk/KioskCallView.tsx',
  'src/components/kiosk/KioskChatDrawer.tsx',
  'src/components/kiosk/KioskFlow.tsx',
  'src/components/kiosk/ai-guidance/AiGuidancePanel.tsx',
  'src/components/kiosk/avatar/guidance.ts',
  'src/components/kiosk/chat/chat-logic.ts',
  'src/components/kiosk/chat/llm-adapter.ts',
  'src/components/kiosk/custom-flow/CustomFlowRenderer.tsx',
  'src/components/kiosk/custom-flow/PurposeSelector.tsx',
  'src/components/kiosk/custom-flow/VisitorInfoForm.tsx',
  'src/components/kiosk/quick-actions.ts',
  'src/app/kiosk/enroll/page.tsx',
  'src/app/kiosk/layout.tsx',
];

function toRepoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** 1 ファイルを AST 解析し、文字列/テンプレート/JSX テキストの CJK リテラルを列挙する。 */
export function findCjkLiterals(filePath: string): CjkViolation[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: CjkViolation[] = [];
  const relFile = toRepoRelative(filePath);

  function report(node: ts.Node, text: string) {
    if (!CJK_PATTERN.test(text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file: relFile, line: line + 1, text: text.trim().slice(0, 60) });
  }

  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      report(node.head, node.head.text);
      for (const span of node.templateSpans) {
        report(span.literal, span.literal.text);
      }
    } else if (ts.isJsxText(node)) {
      report(node, node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * kiosk 配下（既定 `src/components/kiosk` + `src/app/kiosk`）を走査し、allowlist に
 * 無いファイルの生 CJK リテラルを列挙する。空配列 = 違反なし。
 */
export function scanKioskForRawCjk(
  roots: string | readonly string[] = DEFAULT_ROOTS,
): CjkViolation[] {
  const rootList = typeof roots === 'string' ? [roots] : roots;
  const allowlist = new Set(CJK_EXCEPTION_ALLOWLIST);
  const violations: CjkViolation[] = [];
  for (const root of rootList) {
    for (const file of collectSourceFiles(root)) {
      const rel = toRepoRelative(file);
      if (allowlist.has(rel)) continue;
      violations.push(...findCjkLiterals(file));
    }
  }
  return violations;
}
