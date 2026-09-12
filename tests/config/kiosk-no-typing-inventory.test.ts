import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 来訪者向け Kiosk の No Typing 移行ガード (#1057)。
 *
 * 現在は段階移行中なので、既知の typing UI を正確な件数で固定する。
 * `reception-screens-legacy.tsx` は runtime の selectingTarget から外れた旧実装だが、
 * dead code として typing control が残っている間は inventory から隠さない。
 *
 * 新しい visitor UI は inventory に新規エントリを増やさないことが受け入れ条件。
 * 既存入力を CSS で隠すだけでは件数は減らないため、最終状態は空オブジェクトを目指す。
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
      'src/components/kiosk/reception-screens-legacy.tsx': 4,
    });
  });

  it('active selectingTarget route は NoTypingTargetView を使い typing control を持たない', () => {
    const router = readFileSync(join(ROOT, 'reception-screens.tsx'), 'utf8');
    const targetView = readFileSync(join(ROOT, 'NoTypingTargetView.tsx'), 'utf8');

    expect(router).toContain("props.data.state !== 'selectingTarget'");
    expect(router).toContain('<NoTypingTargetView');
    expect(typingControlCount(router)).toBe(0);
    expect(typingControlCount(targetView)).toBe(0);
  });
});
