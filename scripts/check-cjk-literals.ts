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
 *     kiosk コンポーネント。#327 は「退館チェックアウト」「/kiosk/checkout」のみ移行し、
 *     残りの棚卸し・移行は follow-up）。
 *   - allowlist に無いファイル（= checkout/** と将来追加される新規ファイル）は
 *     一致が 1 件でもあれば違反として報告する＝新規の翻訳漏れを検出する。
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
const DEFAULT_ROOT = path.join(REPO_ROOT, 'src/components/kiosk');

/**
 * 例外リスト（未移行の既存 kiosk コンポーネント、リポジトリルートからの相対パス）。
 * #327 では退館チェックアウト導線（checkout/** と KioskFlow.tsx の CheckoutLink）のみ
 * i18n 化する。残りは別トラック/follow-up で棚卸しする既存債務であり、ここに明示する。
 * checkout/** は意図的にここへ追加しない（例外なしで完全検証する）。
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
  'src/components/kiosk/signage/SignageDisplay.tsx',
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
 * kiosk 配下（既定 `src/components/kiosk`）を走査し、allowlist に無いファイルの
 * 生 CJK リテラルを列挙する。空配列 = 違反なし。
 */
export function scanKioskForRawCjk(root: string = DEFAULT_ROOT): CjkViolation[] {
  const allowlist = new Set(CJK_EXCEPTION_ALLOWLIST);
  const violations: CjkViolation[] = [];
  for (const file of collectSourceFiles(root)) {
    const rel = toRepoRelative(file);
    if (allowlist.has(rel)) continue;
    violations.push(...findCjkLiterals(file));
  }
  return violations;
}
