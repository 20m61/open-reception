import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 来訪者向け Kiosk の No Typing 移行ガード (#1057)。
 *
 * 現在の main には文字入力前提が残っているため、このテストは最初から 0 件を要求しない。
 * 代わりに **既知の負債を正確な件数で固定**し、新しい text input / textarea /
 * contentEditable を追加した時点で落とす。#1057 の各置換 PR は、対応したファイルの
 * 件数を減らしてこの inventory を更新する。最終状態は空オブジェクト。
 *
 * NoTypingTargetView のような新しい visitor UI は、この inventory に新規エントリを増やさない
 * こと自体が受け入れ条件になる。既存入力を隠すだけでは件数は減らないため、最終的には DOM から
 * typing control を削除する。
 *
 * checkbox/radio/file/hidden/range/color は typing ではないので対象外。
 * password/numeric/search/tel 等は OS software keyboard を開き得るため対象に含める
 * （数字入力は共通テンキーへ置換する）。
 */

const ROOT = join(process.cwd(), 'src/components/kiosk');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...tsxFiles(path));
    else if (name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const NON_TYPING_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color']);

function typingControlCount(source: string): number {
  let count = 0;

  for (const match of source.matchAll(/<input\b[\s\S]*?>/g)) {
    const tag = match[0];
    const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/)?.[1]?.toLowerCase();
    if (type !== undefined && NON_TYPING_INPUT_TYPES.has(type)) continue;
    count += 1;
  }

  count += (source.match(/<textarea\b/g) ?? []).length;
  count += (source.match(/\bcontentEditable\b/g) ?? []).length;
  return count;
}

function currentInventory(): Record<string, number> {
  return Object.fromEntries(
    tsxFiles(ROOT)
      .map((path) => {
        const count = typingControlCount(readFileSync(path, 'utf8'));
        return [relative(process.cwd(), path).replaceAll('\\', '/'), count] as const;
      })
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe('Kiosk visitor no-typing inventory (#1057)', () => {
  it('既知の typing UI 以外を増やさない', () => {
    expect(currentInventory()).toEqual({
      'src/components/kiosk/KioskChatDrawer.tsx': 1,
      'src/components/kiosk/KioskFlow.tsx': 1,
      'src/components/kiosk/checkout/CheckoutFlow.tsx': 1,
      'src/components/kiosk/custom-flow/VisitorInfoForm.tsx': 2,
      'src/components/kiosk/reception-screens.tsx': 4,
    });
  });
});
