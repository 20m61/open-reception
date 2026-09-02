import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./Field";

/**
 * `Field` の **aria 関連付け** (#892 / 課題 14)。
 *
 * それまで `Field` は補足/エラーを `id={htmlFor}-desc` を持つ span として描画しながら、
 * **それを指す `aria-describedby` を 1 つも出していなかった**。id は振られているので
 * DOM を目で見ると正しく見えるが、支援技術からは補足もエラーも入力に結び付いていない
 * ——「必須です」と赤字で出ているのに、読み上げでは何も言われない。
 *
 * ここで縛るのは分岐ごとの期待値ではなく**不変条件**で、hint / error / required /
 * htmlFor の 16 通りを総当たりする。上界（説明を出したなら必ず指されている）だけでは
 * 「常に付ける」実装が通ってしまうので、**下界**（出していない説明を指さない・
 * エラーが無ければ invalid と言わない）を併せて縛る。
 */

type Options = {
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
};

const CONTROL_ID = "field-under-test";

function render({ hint, error, required, htmlFor }: Options): string {
  return renderToStaticMarkup(
    <Field
      label="ラベル"
      htmlFor={htmlFor}
      hint={hint}
      error={error}
      required={required}
    >
      <input id={CONTROL_ID} defaultValue="" />
    </Field>,
  );
}

/** `<input ...>` の開始タグだけを取り出す（span 側の id と混ざらないように）。 */
function inputTag(html: string): string {
  const m = /<input\b[^>]*>/.exec(html);
  if (!m) throw new Error(`input が描画されていない: ${html}`);
  return m[0];
}

/** `aria-describedby` が指す id（無ければ null）。 */
function describedBy(html: string): string | null {
  const m = /aria-describedby="([^"]*)"/.exec(inputTag(html));
  return m?.[1] ?? null;
}

/** 説明として描画された span の id 全部。 */
function descriptionIds(html: string): string[] {
  return [...html.matchAll(/<span id="([^"]*)"/g)].map((m) => m[1] ?? "");
}

const CASES: Options[] = [];
for (const hint of [undefined, "ヒント文"])
  for (const error of [undefined, "エラー文"])
    for (const required of [false, true])
      for (const htmlFor of [undefined, CONTROL_ID])
        CASES.push({ hint, error, required, htmlFor });

describe("Field の aria 関連付け", () => {
  it.each(CASES)("説明を出したなら入力がそれを指す: %j", (options) => {
    const html = render(options);
    const ids = descriptionIds(html);
    const target = describedBy(html);
    /*
     * 🔴 条件は**入力（props）から**立てる。描画結果の id 有無から立てると、
     * 「span へ id を振らない」実装がこの主張を空虚に満たしてしまう
     * ——「指す先が無いから指さなくてよい」は、まさに直そうとしている欠陥そのもの。
     */
    const hasDescription =
      options.error !== undefined || options.hint !== undefined;

    if (!hasDescription) {
      // 下界: 出していない説明を指さない（「常に付ける」実装をここで落とす）。
      expect(ids).toHaveLength(0);
      expect(target).toBeNull();
      return;
    }
    expect(ids).toHaveLength(1);
    expect(target).toBe(ids[0]);
  });

  it.each(CASES)("エラーのときだけ invalid と言う: %j", (options) => {
    const tag = inputTag(render(options));
    // 下界: error が無い世界で invalid にしない。
    expect(/aria-invalid="true"/.test(tag)).toBe(options.error !== undefined);
  });

  it.each(CASES)("required のときだけ required と言う: %j", (options) => {
    const tag = inputTag(render(options));
    expect(/aria-required="true"/.test(tag)).toBe(options.required === true);
  });

  it("説明は必ず 1 つ（error は hint を置き換える）", () => {
    const html = render({
      hint: "ヒント文",
      error: "エラー文",
      htmlFor: CONTROL_ID,
    });
    expect(descriptionIds(html)).toHaveLength(1);
    expect(html).toContain("エラー文");
    expect(html).not.toContain("ヒント文");
  });

  it("呼び出し側が明示した aria を上書きしない", () => {
    const html = renderToStaticMarkup(
      <Field label="ラベル" htmlFor={CONTROL_ID} error="エラー文">
        <input
          id={CONTROL_ID}
          aria-describedby="caller-owned"
          aria-invalid={false}
        />
      </Field>,
    );
    const tag = inputTag(html);
    expect(tag).toContain('aria-describedby="caller-owned"');
    expect(tag).not.toContain('aria-invalid="true"');
  });

  it("input を包んでいても入力自身に付く（wrapper には付けない）", () => {
    const html = renderToStaticMarkup(
      <Field label="ラベル" htmlFor={CONTROL_ID} hint="ヒント文">
        <div data-testid="wrapper">
          <input id={CONTROL_ID} />
        </div>
      </Field>,
    );
    // wrapper の div へ aria を付けると、読み上げ対象がずれる（div は入力ではない）。
    expect(/<div data-testid="wrapper"[^>]*aria-describedby/.test(html)).toBe(
      false,
    );
  });
});
