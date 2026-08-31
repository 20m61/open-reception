// dynamic-code-execution のフィクスチャ。

declare const input: string;

// ruleid: dynamic-code-execution
eval(input);
// ruleid: dynamic-code-execution
const fn = new Function('a', 'return a + 1');

// 🔴 下界: 名前が似ているだけのものを巻き込まないこと。
// ok: dynamic-code-execution
const evaluated = evaluateExpression(input);
// ok: dynamic-code-execution
const parsed = JSON.parse(input);

function evaluateExpression(s: string): string {
  return s;
}

export const fixture = [fn, evaluated, parsed];
