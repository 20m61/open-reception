'use client';

/**
 * `/platform` 配下の未捕捉例外 (#968 レビュー 6 周目 MAJOR-1)。
 *
 * 🔴 **運用コンソールの例外を来訪者向けの画面に落とさない。**
 *
 * これが無いあいだ、`/platform` の render 例外は `src/app/global-error.tsx` まで上がり、
 * developer に**「受付を続けられませんでした。恐れ入りますが、近くのスタッフにお声がけ
 * ください。」**（日英韓中の 4 言語）が出ていた。運用者は原因も再試行の手段も得られず、
 * しかも自分が来訪者画面を見ていると読む。独立レビューが shape の壊れた 200 を注入して
 * 実測した経路で、デプロイ中のクライアント JS と API のバージョン skew で普通に起こる。
 *
 * 各画面は #968 で「形が違えば読めなかったと報告する」ようになったので、ここへ来るのは
 * **想定外の例外だけ**である。それでも境界は要る —— 想定外は必ず残るし、そのときに
 * 出す言葉は運用者のものであるべきで、来訪者のものではない。
 *
 * 🔴 **例外の内容を画面に出さない**のは `/kiosk` と同じ方針（#629 / #736 Gate A）。
 * `digest` は Next が採番する識別子で PII を含まない。
 */
import { useEffect } from 'react';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';

export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 画面には出さない。切り分けの手掛かりだけ残す（本文・stack は載せない）。
    console.error(JSON.stringify(unexpectedErrorLogLine('platform', error)));
  }, [error]);

  return (
    <section role="alert" data-testid="platform-unexpected-error" style={{ maxWidth: 760 }}>
      <h1 style={{ marginTop: 0 }}>画面を表示できませんでした</h1>
      <p style={{ opacity: 0.85 }}>
        運用コンソールで想定外のエラーが起きました。再試行しても直らない場合は、
        ブラウザを再読み込みしてから、それでも続くようなら開発者へ連絡してください。
        {error.digest ? <> 参照 ID: <code>{error.digest}</code></> : null}
      </p>
      <button type="button" data-testid="platform-unexpected-error-retry" onClick={reset}>
        再試行
      </button>
    </section>
  );
}
