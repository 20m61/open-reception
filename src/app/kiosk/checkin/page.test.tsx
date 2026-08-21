/**
 * 予約 QR の URL が指す先 (#736 Gate A)。
 *
 * ## 事実（修正前）
 *
 * QR には `<origin>/kiosk/checkin?rt=<token>` が載るのに**このルートが無かった**ので、
 * 来訪者が自分のスマホで読むと 404 になっていた。
 *
 * ## 🔴 token を消費しない
 *
 * QR の URL は**受付端末のカメラが読む運び手**で、ブラウザで開かせる前提ではない。
 * `?rt=` を読む経路をここに作ると、`qr-injection.ts` が本番ビルドで注入口を無効に
 * してまで守っている「token を URL クエリに載せない」を裏口から崩す。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '@/lib/i18n';
import Page, { metadata } from './page';

const html = () => renderToStaticMarkup(<Page />);

describe('/kiosk/checkin の案内 (#736)', () => {
  it('受付端末へかざすよう案内する（404 にしない）', () => {
    const markup = html();
    expect(markup).toContain('data-testid="checkin-landing"');
    expect(markup).toContain(makeT('ja')('checkin.landing.title'));
  });

  /**
   * 🔴 **token を読まない・送らない・表示しない。** ここは props も searchParams も
   * 受け取らない形にしてある（受け取れないなら漏らしようがない）。
   */
  it('🔴 token を受け取らない（引数を持たない）', () => {
    expect(Page.length, 'searchParams などを受け取る形にしない').toBe(0);
  });

  it('🔴 予約 URL を検索・共有経路へ載せない', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  /**
   * 言語判定をしない（来訪者の端末設定に依存させない）。読める言語が 1 つあれば伝わる。
   */
  it('4 言語を並べる', () => {
    const markup = html();
    for (const lang of ['ja', 'en', 'ko', 'zh']) {
      expect(markup, `${lang} が無い`).toContain(`lang="${lang}"`);
    }
  });

  /**
   * 🔴 技術的な文言を来訪者へ出さない（#629 と同じ方針）。
   */
  it('🔴 技術的な文言を出さない', () => {
    const markup = html();
    for (const word of ['404', 'Not Found', 'error', 'Error', 'token']) {
      expect(markup, `${word} が出ている`).not.toContain(word);
    }
  });
});
