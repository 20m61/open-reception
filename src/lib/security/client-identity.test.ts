/**
 * 試行予算の一次鍵に使う**発信元の識別**（#1021 AC4 / レビュー B1）。
 *
 * ## なぜこれが必要か
 *
 * 当初この増分は「非詐称可能な識別子は無いので予算の鍵は global しか選べない」と
 * 判断していた。**その前提はこのリポジトリ自身のコードで反証される**:
 *
 * - `src/lib/admin/audit.ts` は `x-forwarded-for` の **末尾** を採る。doc がまさに
 *   「CloudFront は client 提供の XFF の**右側**に実 client IP を追記するため、
 *   **先頭値は client 詐称可能**」と書いている
 * - `src/proxy.ts` の origin-verify が **全ルートで** CloudFront 迂回を拒否する
 *
 * つまり本番では **XFF の末尾は詐称できない viewer IP** である。authorize route が
 * 読んでいる `split(',')[0]`（先頭＝詐称可能）から一般化したのが誤りだった。
 *
 * ## なぜ鍵が global だと困るか（レビュー B2）
 *
 * global ＋ ロックアウトだと、攻撃者が少量のリクエストを投げ続けるだけで
 * **運用者が無期限に入れない**。しかも kiosk の復旧経路（エンロール URL の発行）は
 * admin セッションを要求し、その入口は `/api/admin/login` だけなので、
 * **受付が復旧不能になる**。一次鍵を発信元にすれば、他人の失敗で閉まらない。
 */
import { describe, expect, it } from 'vitest';
import { clientIdentity, GLOBAL_IDENTITY } from './client-identity';

const req = (xff?: string) =>
  new Request('https://example.test/api/kiosk/authorize', {
    method: 'POST',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

describe('発信元の識別 (#1021 AC4)', () => {
  /**
   * 🔴 **本体。末尾を採る。** 先頭は client が詐称できるので、先頭を採ると
   * **鍵を回すだけで予算が素通り**する（それは予算ではない）。
   */
  it('🔴 XFF の末尾を採る（先頭は詐称可能）', () => {
    expect(clientIdentity(req('203.0.113.9, 198.51.100.7, 192.0.2.1'))).toBe('ip:192.0.2.1');
  });

  it('1 つだけならそれを採る', () => {
    expect(clientIdentity(req('192.0.2.1'))).toBe('ip:192.0.2.1');
  });

  /**
   * 🔴 **詐称された先頭に引きずられない（下界）。** 攻撃者が先頭へ別の IP を
   * 詰めても、鍵は末尾で決まる。
   */
  it('🔴 攻撃者が先頭に何を詰めても鍵は変わらない', () => {
    const a = clientIdentity(req('1.1.1.1, 192.0.2.1'));
    const b = clientIdentity(req('2.2.2.2, 3.3.3.3, 192.0.2.1'));
    expect(a).toBe(b);
  });

  /** 空白・空要素を落とす（`a, , b` のような綴り）。 */
  it('空要素を落とす', () => {
    expect(clientIdentity(req('1.1.1.1, , 192.0.2.1 '))).toBe('ip:192.0.2.1');
  });

  /**
   * 🔴 **識別できないときは global へ退避する（fail-safe）。**
   *
   * ヘッダが無いのは CloudFront を経ないデプロイ（ローカル開発・Function URL 直叩きが
   * 許されている構成）である。`undefined` を鍵にすると**全員が同じ鍵**になるので、
   * 明示的に global の鍵へ倒して**予算が消えないこと**を保証する。
   */
  it.each([undefined, '', '   ', ','])('🔴 識別できない（%j）なら global へ退避する', (xff) => {
    expect(clientIdentity(req(xff))).toBe(GLOBAL_IDENTITY);
  });

  /**
   * 🔴 **鍵に接頭辞を付ける。** `ip:` を付けないと、`GLOBAL_IDENTITY` と同じ文字列を
   * XFF に詰めるだけで**global の予算を狙って消費させられる**（鍵の衝突）。
   */
  it('🔴 global の鍵を XFF から名乗れない', () => {
    expect(clientIdentity(req(GLOBAL_IDENTITY))).toBe(`ip:${GLOBAL_IDENTITY}`);
    expect(clientIdentity(req(GLOBAL_IDENTITY))).not.toBe(GLOBAL_IDENTITY);
  });

  /** 🔴 鍵に PII を増やさない（IP 以外のヘッダを混ぜない）。 */
  it('🔴 鍵は IP だけで、user-agent 等を混ぜない', () => {
    const withUa = new Request('https://example.test/x', {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Mozilla/5.0 (iPad)' },
    });
    expect(clientIdentity(withUa)).toBe('ip:192.0.2.1');
  });
});
