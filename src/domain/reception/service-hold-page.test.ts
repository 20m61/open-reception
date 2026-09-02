/**
 * 全断時に来訪者へ出す応答の内容判定 (#629 / N2a)。
 *
 * ## なぜ要るか
 *
 * origin-verify が拒否したとき、iPad の全画面に出るのは英語 1 語の `forbidden` だけだった
 * （`src/proxy.ts` の `denyOriginVerify`）。matcher は `/kiosk` を含むので、
 * **来訪者が最初に見る画面**がこれになる。再試行導線もスタッフ呼出導線も無い。
 *
 * ## なぜ CloudFront ではなくここか
 *
 * issue #629 の「やること」は CloudFront の custom error response だが、あれは
 * **ディストリビューション単位でしか設定できず cache behavior に絞れない**ので、
 * 403/503 を割り当てると **API の 403/503 応答まで HTML に差し替わる**
 * （`PROVIDER_WEBHOOKS_DISABLED` の 503 + `Retry-After` は Vonage の再送に効いている
 * 運用スイッチ）。origin-verify の拒否は **middleware 自身が返している**ので、
 * ここで `Accept` を見れば **CloudFront に触れずに** 来訪者向けの応答を出せる。
 * API の意味は 1 バイトも変わらない。
 */
import { describe, expect, it } from 'vitest';
import { prefersHtml, renderServiceHoldPage } from './service-hold-page';

describe('prefersHtml (#629)', () => {
  it('ブラウザの画面遷移には HTML を返す', () => {
    expect(prefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true);
  });

  /**
   * 🔴 **API と webhook には HTML を返さない。** ここを取り違えると、Vonage の再送や
   * 端末のポーリングが HTML を受け取る。#629 が CloudFront を避けた理由そのもの。
   */
  it.each([
    ['application/json', 'API クライアント'],
    ['*/*', 'curl / webhook の既定'],
    ['', 'ヘッダなし'],
  ])('%s（%s）には HTML を返さない', (accept) => {
    expect(prefersHtml(accept)).toBe(false);
  });

  it('Accept ヘッダが無いときも HTML を返さない', () => {
    expect(prefersHtml(null)).toBe(false);
  });

  it('text/html を明示していれば q 値の順序によらず HTML を返す', () => {
    expect(prefersHtml('application/json;q=0.9,text/html;q=0.8')).toBe(true);
  });
});

describe('renderServiceHoldPage (#629)', () => {
  const page = renderServiceHoldPage();

  it('🔴 来訪者が次に何をすればよいか書いてある', () => {
    // 「forbidden」だけでは何も分からない。スタッフ呼出という**実行可能な次の一手**を出す。
    expect(page).toContain('スタッフ');
  });

  it.each([
    ['ja', '受付'],
    ['en', 'reception'],
    ['ko', '접수'],
    ['zh', '接待'],
  ])('%s の案内を含む', (_lang, marker) => {
    expect(page.toLowerCase()).toContain(marker.toLowerCase());
  });

  /**
   * 🔴 **middleware から返るので、外部リソースもスクリプトも使えない。**
   * この応答は Next のレンダリングを通らない（`_next/static` も matcher の外）。
   * 外部参照があると全断中にそれ自体が失敗して白画面になる。
   */
  it('🔴 スクリプトを含まない', () => {
    expect(page).not.toMatch(/<script/i);
  });

  it('🔴 外部リソースを参照しない（全断中に取りに行けない）', () => {
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/<img\b/i);
  });

  /**
   * 🔴 **理由を外へ出さない。** 既存の `denyOriginVerify` の doc が書いているとおり、
   * `missing-secret`（503）と不一致（403）を本文で区別すると**迂回可能な時間帯を教える**。
   * 来訪者にとっても区別に意味は無いので、両方で同じ文面を出す。
   */
  it('🔴 失敗の理由を漏らさない', () => {
    for (const leak of ['origin-verify', 'missing-secret', 'secret', 'CloudFront', 'forbidden']) {
      expect(page.toLowerCase(), `${leak} が本文に出ている`).not.toContain(leak.toLowerCase());
    }
  });

  it('横向き iPad で読めるよう viewport を持つ', () => {
    expect(page).toContain('viewport');
  });
});
