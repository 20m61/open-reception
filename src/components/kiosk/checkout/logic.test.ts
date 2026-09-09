import { describe, expect, it } from 'vitest';
import { makeT } from '@/lib/i18n';
import {
  CHECKOUT_CONFIRM_TIMEOUT_MS,
  CHECKOUT_CONFIRM_TIMEOUT_REASON,
  CHECKOUT_FAILURE_MESSAGE,
  CHECKOUT_RESOLVE_TIMEOUT_MS,
  isTimeout,
} from './logic';

describe('CHECKOUT_FAILURE_MESSAGE (issue #102 / #327 i18n)', () => {
  it('失敗理由ごとに来訪者向け文言を返す（PII を含まない, ja）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toContain('見つかりません');
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toContain('退館済み');
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toContain('受付番号');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toContain('通信エラー');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toContain('通信エラー');
  });

  it('en locale では日本語が一切露出しない', () => {
    const tr = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toBe(
      'We could not find that reception number. Please check the number and try again.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toBe(
      'This reception number has already been checked out.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toBe('Please enter a reception number.');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toBe('A network error occurred. Please try again.');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toBe('A network error occurred. Please try again.');
  });

  it('ko / zh locale でも対応する文言を解決する', () => {
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('ko'))).toContain('접수 번호');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('zh'))).toContain('受理编号');
  });

  it('自己特定（#328/#339）由来の失敗理由も文言化する（expired/throttled/not_recognized）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', tr)).toContain('有効期限');
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', tr)).toContain('制限');
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', tr)).toContain('確認できませんでした');
    // en でも日本語が露出しない。
    const en = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', en)).toBe(
      'This checkout code has expired. Please ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', en)).toBe(
      'Too many checkout code attempts. Please wait a moment, use your checkout QR, or ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', en)).toBe(
      'We could not recognize that checkout code or visit target. Please check and try again.',
    );
  });
});

describe('締切による中断の扱い (#1029)', () => {
  const ja = makeT('ja');

  it('締切の中断は TimeoutError で見分ける', () => {
    // `AbortSignal.timeout` が投げるもの。
    expect(isTimeout(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  /*
    🔴 **下界。** ここを「例外なら全部締切」に倒すと、サーバへ**届いていない**失敗まで
    「退館できたか分かりません」と言い、再試行すれば済む来訪者を受付へ歩かせることになる。
  */
  it('接続そのものの失敗は締切ではない', () => {
    expect(isTimeout(new TypeError('Failed to fetch'))).toBe(false);
    // 手動 abort（`AbortController.abort()`）も締切ではない。
    expect(isTimeout(new DOMException('aborted', 'AbortError'))).toBe(false);
    for (const other of [null, undefined, 'TimeoutError', 42, {}, { name: 'Error' }]) {
      expect(isTimeout(other)).toBe(false);
    }
  });

  /*
    🔴 **成功を否定しない言い方であること**（#968 が `read-response.ts` に明文化した理由）。
    中断したのはこちらの待ちであって、サーバは退館を受理しているかもしれない。
  */
  it('退館確定の締切は、失敗と断定せず受付へ繋ぐ', () => {
    const message = CHECKOUT_FAILURE_MESSAGE(CHECKOUT_CONFIRM_TIMEOUT_REASON, ja);
    expect(message).toContain('受付');
    expect(message).toContain('分かりません');
    // 既定（`network`）へ倒す変異をここで落とす ―― あれは再試行だけを促す。
    expect(message).not.toContain('もう一度お試しください');
    expect(message).not.toBe(CHECKOUT_FAILURE_MESSAGE(undefined, ja));
  });

  /*
    🔴 **サーバの予算より長いこと**（`infra/lib/config/environments.ts` の
    `serverTimeoutSec` は 3 環境とも 30 秒）。同じかそれ以下にすると、サーバ自身の応答が
    必ずこちらの中断に負け、「確実に完了しなかった」という知り得たはずの事実に到達できない。
  */
  it('退館確定の締切はサーバの予算より長く、resolve より長い', () => {
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeGreaterThan(CHECKOUT_RESOLVE_TIMEOUT_MS);
  });

  /*
    🔴 **締切が無限でないこと。** 「締切を付けた」を主張するテストは、値を極端に
    大きくする変異（＝実質無い）を素通りさせやすい。来訪者が端末の前で待てる範囲に縛る。
  */
  it('締切は来訪者が端末の前で待てる範囲に収まる', () => {
    expect(CHECKOUT_RESOLVE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
  });
});
