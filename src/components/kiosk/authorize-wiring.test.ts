/**
 * PIN 画面の**配線**を静的に固定する (#1021 AC4)。
 *
 * ## なぜソースを読む形にしたか
 *
 * 🔴 **#826 の教訓**: 純関数の分岐を 4/4 kill しても、**配線を変異させていない**だけで
 * 保証は丸ごと落ちる（`KioskFlow` を元へ戻しても unit・e2e とも緑だった）。
 *
 * この面を実行時に縛る手段が無い:
 *
 * - このリポジトリには**対話的な component テストの仕組みが無い**
 *   （component テストは `renderToStaticMarkup` による SSR 文字列で、submit → fetch →
 *   state 遷移を起こせない）
 * - 429 の e2e も書けない —— 予算の鍵は**サイト全体**なので、使い切ると窓（10 分）が
 *   明けるまで**スイート全体が汚染**され、使い切った後は成功で戻すこともできない
 *
 * そこで**配線を 1 式へ寄せ**（`authorizeStateFromResponse`）、その 1 行が在ることと、
 * 原因を決め打ちしていないことをソースに対して主張する。実測できないものを
 * 「縛った」と書かないための形である。
 *
 * 🔴 **これは網羅ではない。** ソースの文字列検査なので、同じ意味の別の綴りは見逃す。
 * 「配線が変異しても気づかない」状態より良い、というだけである。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./KioskFlow.tsx', import.meta.url), 'utf8');

/** PIN 許可の submit ハンドラ本体（前後の関数を巻き込まない範囲で切り出す）。 */
function authorizeSubmitSource(): string {
  const start = SOURCE.indexOf('function KioskAuthorizeView');
  expect(start, 'KioskAuthorizeView が見つからない（改名したらこのテストを直す）').toBeGreaterThan(
    -1,
  );
  const end = SOURCE.indexOf('\nfunction ', start + 1);
  return SOURCE.slice(start, end === -1 ? undefined : end);
}

describe('PIN 画面の配線 (#1021 AC4)', () => {
  it('🔴 応答から状態を作るのは authorizeStateFromResponse である', () => {
    expect(authorizeSubmitSource()).toContain('authorizeStateFromResponse(res.status');
  });

  /**
   * 🔴 **Retry-After を渡している**（渡さないと「約 N 秒後」が出ず、
   * 来訪者は「いつ直るのか」が分からない。変異 M35 が生存した穴）。
   */
  it('🔴 Retry-After ヘッダを渡している', () => {
    expect(authorizeSubmitSource()).toContain("res.headers.get('retry-after')");
  });

  /**
   * 🔴 **原因を決め打ちしていない**（変異 M36 が生存した穴）。
   * ここに `'wrong_pin'` 等のリテラルが現れたら、状態コードを見ずに丸めている。
   */
  it('🔴 失敗の原因をリテラルで決め打ちしていない', () => {
    const src = authorizeSubmitSource();
    // `unreachable` だけは catch 節の正当なリテラル（fetch が reject＝応答が無い）。
    const literals = [...src.matchAll(/failure: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(literals).toEqual(['unreachable']);
  });

  /** 🔴 下界: 文言は原因から引いている（1 つの文言へ丸めていない）。 */
  it('🔴 文言は authorizeFailureMessage から引く', () => {
    expect(SOURCE).toContain('authorizeFailureMessage(state.failure, state.retryAfterSec, locale)');
  });

  /**
   * 🔴 **locale を渡している (#327)。** 渡さないと既定 locale（ja）に固定され、
   * 多言語運用の来訪者に**日本語だけ**が出る（辞書を足した意味が消える）。
   */
  it('🔴 文言に locale を渡している', () => {
    expect(SOURCE).toContain('<KioskAuthorizeView onAuthorized={markAuthorized} locale={locale} />');
  });
});
