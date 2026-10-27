/**
 * 受付端末エンロール画面の文言が**原因を偽らない** (#1123)。
 *
 * ## 何が問題だったか
 *
 * #1123 が `/api/kiosk/enroll` に新しいエラーコード `unavailable`（503 = サーバ側の
 * 設定不備）を足したとき、**唯一のクライアントを更新していなかった**。未知コードは
 * `FALLBACK_ERROR`（「URLが無効か期限切れです／**管理画面で再発行してください**」・
 * `retryable: false`）へ落ちるので:
 *
 * - 原因が**嘘**（鍵の設定漏れなのに「URL が無効」）
 * - 対処も**嘘**（再発行しても `issueEnrollmentToken` が同じ鍵で落ちる）
 * - **再試行ボタンも出ない**（`retryable: false`）
 *
 * 設置者は袋小路をループする。担当者側（#973 / #1021 / #1123 AC4）とまったく同型の嘘で、
 * 片方だけ直して受付端末側を残していた。
 *
 * 🔴 このページは client component なので、文言表だけを切り出して縛る
 * （component テストは `renderToStaticMarkup` で、fetch の相互作用を踏めない）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../domain/governance/fetch-failure-scan';

const source = readFileSync(join(process.cwd(), 'src/app/kiosk/enroll/page.tsx'), 'utf8');

/**
 * 🔴 **コメントを落としてから見る。** 実装コメントは「なぜその文言にしないか」を説明する
 * ために当の鍵名を引用するので、込みで探すと検査が誤検出する（#960 で踏んだ型の裏返し）。
 */
const code = stripComments(source);

/**
 * 文言表そのもの。**ファイル全体へ当てない** —— 表の外に同名のキーがあれば通ってしまう
 * （PII 検査と `retryable` 検査は既に表／エントリへ絞っていたのに、行の存在検査だけが
 * ファイル全体を見ていた。#1123 のレビュー 6 周目）。
 */
const table = code.slice(code.indexOf('const ERROR_MESSAGE'), code.indexOf('function toError'));

/**
 * route が返しうるエラーコードを、**route のソースから導く**
 * （`src/app/api/kiosk/enroll/route.ts` ＋ 503 を返す共有モジュール）。
 *
 * 🔴 **手で数え上げない。** 以前はここが literal の配列で、**route が新しいコードを足しても
 * 緑のまま**だった —— クライアントは `FALLBACK_ERROR`＝「再発行してください」へ落ちるので、
 * #1123 が直したその嘘が黙って復活する。担当者側は `StaffFailure` の union を switch が
 * 網羅するので TS が強制するのに対し、受付端末側は `Record<string, ErrorCopy>` なので
 * 型では縛れない。**型で縛れないなら、ソースから導く。**
 *
 * 🔴 **導出は「見つからなかった＝無い」になりうる。** 正規表現が 1 つも当たらなければ
 * `it.each` は 0 本走って**空虚に緑**になるので、下の「導出そのものの検査」で下界を縛る。
 */
const routeSource = stripComments(
  readFileSync(join(process.cwd(), 'src/app/api/kiosk/enroll/route.ts'), 'utf8'),
);
const policySource = stripComments(
  readFileSync(join(process.cwd(), 'src/lib/auth/secret-unavailable.ts'), 'utf8'),
);

function deriveApiErrorCodes(): string[] {
  const codes = new Set<string>();
  // 1. route が直接書く literal（`{ error: 'invalid_token', … }`）。
  const addAll = (text: string, re: RegExp): void => {
    for (const m of text.matchAll(re)) if (m[1]) codes.add(m[1]);
  };
  addAll(routeSource, /\berror:\s*'([a-z_]+)'/g);
  // 2. `error: result.reason` で返す分は、status 表のキーがそのままコードになる。
  const failureTable = routeSource.match(/const FAILURE_STATUS[^=]*=\s*\{([^}]*)\}/)?.[1];
  if (failureTable) addAll(failureTable, /^\s*([a-z_]+)\s*:/gm);
  // 3. 503 は共有モジュールが組み立てるので、そちらの literal を読む。
  if (routeSource.includes('secretUnavailableResponse(')) {
    addAll(policySource, /\berror:\s*'([a-z_]+)'/g);
  }
  return [...codes].sort();
}

const API_ERROR_CODES = deriveApiErrorCodes();

describe('エンロール画面の文言 (#1123)', () => {
  /**
   * 🔴 **本体。** route が返しうるコードは全部、表に明示の行を持つ。
   * `FALLBACK_ERROR` へ落ちると「URL が無効」と嘘の原因を出す。
   */
  it.each(API_ERROR_CODES)('🔴 %s が文言表に在る（fallback へ落ちない）', (errorCode) => {
    // 🔴 `source` ではなく `table`（コメント除去済み・表の範囲だけ）に当てる。
    // 実装コメントが行名を引用しているだけで緑になっては、「表に在る」を主張したことに
    // ならない（レビュー 5 周目）。表の外で通るのも同じ理由で駄目（6 周目）。
    expect(table).toMatch(new RegExp(`^\\s*${errorCode}:`, 'm'));
  });

  /**
   * 🔴 **導出そのものの下界。** 上の `it.each` は、導出が空配列を返すと**0 本走って緑**になる。
   * 「見つからなかった」は「無い」ではない（`CLAUDE.md`「調査の作法」）。
   * 実在するコードが拾えていることと、**拾いすぎていないこと**（負の対照）を併せて縛る。
   */
  it('🔴 route からのコード導出が空でも過剰でもない（負の対照つき）', () => {
    expect(API_ERROR_CODES).toEqual(['invalid_token', 'not_found', 'revoked', 'unavailable', 'used']);
    expect(API_ERROR_CODES).not.toContain('ok');
  });

  /**
   * 🔴 **サーバ側の問題は再試行できる。** `retryable: false` にすると再試行ボタンが
   * 消え、「管理画面で再発行」という**実行しても直らない**指示だけが残る。
   */
  it('🔴 unavailable は retryable（再試行できる）', () => {
    const block = source.slice(source.indexOf('  unavailable: {'));
    expect(block.slice(0, block.indexOf('},'))).toContain('retryable: true');
  });

  /**
   * 🔴 受付端末の画面は**来訪者からも見える**。設定の内訳を出さない。
   * 担当者側（`staff-failure.test.ts`）は全種別に当てているので、こちらも全行に当てる。
   */
  it('🔴 文言に env 名・鍵名を出さない（表の全行）', () => {
    expect(table).not.toMatch(/SECRET|KIOSK_[A-Z_]+|dev-insecure/);
  });

  /**
   * 失敗の表示が支援技術へ**提示される**（発話するとは主張しない ——
   * `docs/handoff-2026-08-26.md` の失敗 3）。
   *
   * 🔴 **「担当者側と対にした」とは書かない。** 実態は対になっていない ——
   * 担当者側の `staff-call-status` は `role="status"` を持つが**それを縛る assertion は無く**
   * （e2e は testid でしか取らない）、しかも向こうは**常時マウント**でこちらは**条件マウント**
   * なので、live region としての性質自体が違う。揃えるのは #1130。
   * ここが主張するのは「この要素に `role` が付いている」だけである。
   */
  it('エラー表示が支援技術へ提示される（role を持つ）', () => {
    const block = source.slice(source.indexOf('data-testid="enroll-error"'));
    expect(block.slice(0, block.indexOf('>'))).toContain('role="status"');
  });

  /**
   * 🔴 **下界。** 「全部の行が在る」だけなら、**全部を同じ文言**にしても満たせる。
   * 端末側エラー（再発行が正しい対処）と サーバ側エラーが別文言であることを見る。
   */
  it('🔴 unavailable は「再発行してください」と言わない（下界）', () => {
    const block = source.slice(source.indexOf('  unavailable: {'));
    expect(block.slice(0, block.indexOf('},'))).not.toContain('再発行');
  });
});
