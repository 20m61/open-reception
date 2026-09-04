'use client';

/**
 * ヘッダ（layout が描く領域）の例外を運用コンソール内に閉じ込める
 * (#968 レビュー 7 周目 BLOCKER-1)。
 *
 * ## なぜ `src/app/platform/error.tsx` では足りないのか
 *
 * Next の `error.tsx` は**同じセグメントの layout が投げた例外を捕まえない**。
 * `TenantSwitcher` は `src/app/platform/layout.tsx` が描画しているので、そこで投げると
 * 例外は root まで上がり `src/app/global-error.tsx` の**来訪者向け 4 言語**
 * 「受付を続けられませんでした。恐れ入りますが、近くのスタッフにお声がけください。」が
 * **platform の全画面**に出る。独立レビューが `{"tenants":[null]}` を注入して実測した。
 *
 * ヘッダは全画面共通なので、テナント一覧 API の形が壊れた瞬間に運用コンソールが丸ごと
 * 使えなくなる —— しかも運用者は「自分は受付端末の画面を見ている」と読む。
 *
 * 述語（`isTenantListShape`）で既知の経路は塞いだが、**境界はそれとは別に要る**。
 * 想定外は必ず残るし、ヘッダが落ちても**本文は読めるべき**である。
 *
 * 🔴 例外の内容は画面に出さない（`/kiosk` と同じ方針・#629 / #736 Gate A）。
 */
import { Component, type ReactNode } from 'react';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';

type Props = { children: ReactNode };
type State = { failed: boolean };

export class HeaderErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    // 画面には出さない。切り分けの手掛かりだけ残す（本文・stack は載せない）。
    console.error(JSON.stringify(unexpectedErrorLogLine('platform', error)));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <span role="alert" data-testid="platform-header-error" style={{ opacity: 0.85 }}>
        テナント切替を表示できません
      </span>
    );
  }
}
