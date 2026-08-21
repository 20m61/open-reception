/**
 * `/kiosk/checkin` — 予約 QR の URL が指す先 (#736 Gate A)。
 *
 * ## なぜこのページが要るのか
 *
 * 予約 QR には `<origin>/kiosk/checkin?rt=<token>` が載る（`buildReservationCheckinUrl`）。
 * **このルートは存在しなかった**ので、来訪者が自分のスマホで QR を読むと 404 になっていた
 * ── iPad にも来訪者のスマホにも生の技術的エラーを出さない、という方針
 * （#629 / `service-hold-page.ts`）に反する。
 *
 * ## 🔴 token を消費しない
 *
 * URL の `?rt=` を読んで自動照合する作りには**しない**。QR の URL は
 * **受付端末のカメラが読む運び手**で（`extractReservationToken` が URL 形式を解析する）、
 * ブラウザで開かせる前提ではない。`qr-injection.ts` はデバッグ用の注入口を本番ビルドで
 * 無効にしてまで「token を URL クエリに載せない」を守っている ── ここで `?rt=` を
 * 読む経路を作ると、その判断を裏口から崩す（アクセスログ・履歴・Referer に残る）。
 *
 * よってこのページは **token を読まず・送らず・表示しない**。受付端末へ QR をかざすよう
 * 案内するだけにする。
 *
 * 「来訪者が自分のスマホから受付を完了できるべきか」は主要 Journey の仕様判断なので、
 * 決めずに残す（#736 の Decision Inbox）。
 *
 * ## 多言語
 *
 * 言語判定をしない（来訪者の端末の設定に依存させない）。`service-hold-page.ts` と同じく
 * 4 言語を並べる ── 読める言語が 1 つあれば伝わる。
 */
import type { Metadata } from 'next';
import { makeT } from '@/lib/i18n';

export const metadata: Metadata = {
  // 予約 URL が検索・共有経路へ載らないようにする（token がクエリに付いたまま辿られない）。
  robots: { index: false, follow: false },
};

/**
 * 並べる言語。**言語判定をしない**（来訪者の端末設定に依存させない）。
 * 文言は辞書から引く ── kiosk 配下に生の CJK リテラルを置かない（#327）。
 */
const LANGS = ['ja', 'en', 'ko', 'zh'] as const;

export default function KioskCheckinLandingPage() {
  return (
    <main
      data-testid="checkin-landing"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-lg)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
        textAlign: 'center',
      }}
    >
      {LANGS.map((lang) => {
        const tr = makeT(lang);
        return (
          <section key={lang} lang={lang} style={{ maxWidth: 560 }}>
            <h1 style={{ fontSize: 'clamp(1.4rem, 4vw, 1.9rem)', margin: 0, lineHeight: 1.3 }}>
              {tr('checkin.landing.title')}
            </h1>
            <p style={{ opacity: 0.82, margin: 'var(--space-sm) 0 0', lineHeight: 1.7 }}>
              {tr('checkin.landing.lead')}
            </p>
          </section>
        );
      })}
    </main>
  );
}
