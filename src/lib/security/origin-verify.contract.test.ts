import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORIGIN_VERIFY_HEADER,
  ORIGIN_VERIFY_REQUIRED_ENV,
  ORIGIN_VERIFY_SECRET_ENV,
} from './origin-verify';

/**
 * origin-verify のヘッダ名 / env 名は、アプリ（このモジュール）と CDK
 * (`infra/lib/stacks/web-stack.ts`) が**同じ値を二重に持っている**。infra は別 tsconfig で
 * `src/` を型解決できないため、import で 1 本化できない。
 *
 * ドリフト検査を **`src/` 側に置いている**のは、`infra/test/**` が品質ゲートの unit ステップ
 * （root `vitest.config.ts` の include）に入っておらず**一度も実行されない**ため（issue #628）。
 * 逆向き（infra 側に置いて src を読む）だと、この契約は守られているように見えて実際には
 * 誰も検査していない状態になる。
 *
 * また**両側を突き合わせる**。片側のリテラルが在ることだけを見ると、
 * infra 側の定数を書き換えても緑のままになる。
 */
const WEB_STACK = path.join(process.cwd(), 'infra', 'lib', 'stacks', 'web-stack.ts');

describe('origin-verify の定数が CDK と一致する (#612)', () => {
  const source = fs.readFileSync(WEB_STACK, 'utf8');
  /**
   * コメント行を除いた本文。**否定的な検査（「〜が無いこと」）にだけ使う。**
   * 素朴な正規表現でコメントを剥がすと、文字列中の `//`（URL 等）やブロック境界を
   * 誤って食ってコード本体まで消える（実際に消えた）。行単位に限定して安全側に倒す。
   */
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  /**
   * `const NAME = 'value';` を全て拾って name → value の表にする。
   *
   * - **値だけを比較する。** 宣言のテキストごと照合すると、Prettier 設定変更や lint autofix で
   *   クォートが `"` に変わっただけで落ち、挙動が同じなのにビルドが壊れる。
   * - 正規表現は**ハードコード**し、名前で `new RegExp()` を組み立てない
   *   （semgrep `detect-non-literal-regexp` が blocking で止める。テスト内でも例外にしない）。
   */
  const declaredConsts = new Map<string, string>();
  for (const match of source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*['"]([^'"]*)['"]/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) declaredConsts.set(name, value);
  }

  it.each([
    ['ORIGIN_VERIFY_HEADER', ORIGIN_VERIFY_HEADER],
    ['ORIGIN_VERIFY_SECRET_KEY', ORIGIN_VERIFY_SECRET_ENV],
    ['ORIGIN_VERIFY_REQUIRED_KEY', ORIGIN_VERIFY_REQUIRED_ENV],
  ])('web-stack.ts の %s がアプリ側と同じ値', (cdkName, appValue) => {
    // 定数が消えた（リネームされた）場合も undefined で落ちる。
    expect(declaredConsts.get(cdkName)).toBe(appValue);
  });

  it('CDK が両方の env を server Lambda に渡している', () => {
    // 値の供給が片方だけになると、REQUIRED だけ立って全リクエストが 503 になる。
    expect(source).toContain('addEnvironment(ORIGIN_VERIFY_REQUIRED_KEY');
    expect(source).toContain('addEnvironment(ORIGIN_VERIFY_SECRET_KEY');
  });

  // 🔴 呼び出しの**存在**だけを見ると、値の書き換えが素通りする。
  // `'1'` → `'0'` にされると `readOriginVerifyConfig` は required:false を返し、
  // Function URL が authType=NONE のまま**検証が黙って OFF** になる（#612 が塞ぐ穴そのもの）。
  it('ORIGIN_VERIFY_REQUIRED に立てる値が真である', () => {
    expect(source).toMatch(/addEnvironment\(\s*ORIGIN_VERIFY_REQUIRED_KEY\s*,\s*'1'\s*\)/);
  });

  // 🔴 ヘッダ名をリテラルに書き換えられると、CloudFront は誰も見ないヘッダを送る
  // ＝ 全リクエストが 403。定数から導いていることを固定する。
  it('CloudFront の origin custom header を定数から組み立てている', () => {
    expect(source).toMatch(/\[\s*ORIGIN_VERIFY_HEADER\s*\]\s*:/);
  });

  // 🔴 引数ガードは `assertBuildArtifacts()` より前でなければ、`.open-next` の無い
  // クリーンな checkout でガードのテストが「成果物が無い」で落ちて検証できなくなる。
  // 並べ替えを戻す変更をここで止める（infra テストはゲートで走らないため src 側で固定する）。
  it('引数ガードがビルド成果物チェックより前に置かれている', () => {
    const guard = source.indexOf('に空文字/非文字列が渡されました');
    const artifacts = source.indexOf('this.assertBuildArtifacts()');
    expect(guard).toBeGreaterThan(-1);
    expect(artifacts).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(artifacts);
  });

  it('CDK が origin-verify シークレットを ARN 経由の runtime 解決に戻していない', () => {
    // middleware は OpenNext の routing 層から instrumentation の register() より **先** に呼ばれ、
    // しかも拒否応答を返すと Next サーバへ到達しないので register() は永久に走らない。
    // 結果、コールドスタート直後の正当なリクエストが落ちる。回復は matcher 除外パスが
    // 同じインスタンスに当たったときだけなので、リクエスト順に依存する断続障害になる。
    // よって ARN を渡して runtime 解決する形へ戻す変更をここで止める。
    //
    // **リテラル 'ORIGIN_VERIFY_SECRET_ARN' だけを見ないこと。** 実際の記述は
    // `` `${ORIGIN_VERIFY_SECRET_KEY}_ARN` `` というテンプレートリテラルだったので、
    // 素朴な toContain は ARN 版のコードが在るまま緑になる（実際にそうなった）。
    //
    // **コメントを除いた本文で判定する。** 素朴に全文を見ると、この事情を説明する
    // コメントを web-stack.ts に書いただけでゲートが赤くなる（挙動は同じなのに）。
    expect(code).not.toMatch(/ORIGIN_VERIFY_SECRET(_KEY\}?)?_ARN/);
    expect(code).not.toContain("'OriginVerifySecret'");
  });
});
