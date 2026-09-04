/**
 * 運用コンソールの境界に主張を置く (#968 レビュー 8 周目 MAJOR-1)。
 *
 * ## 事実（このテストが無かったとき）
 *
 * `src/app/platform/error.tsx` と `HeaderErrorBoundary` を**両方とも削除**しても、
 * unit 7611 本が全部緑だった（レビューの実測）。境界を足したコミットに、境界を守る
 * 主張が 1 本も無かった。
 *
 * `CLAUDE.md`「主修正とフォールバックを同じコミットで入れない —— フォールバックは
 * 主修正が壊れたときの症状を**大声の失敗から沈黙の誤動作へ変換する**」の型。
 * ここでは順序を変えられないので（境界は後から足すしかない）、**境界そのものに
 * 主張を置く**ことで代える。
 *
 * ## なぜ境界が要るのか（等価ではない証拠）
 *
 * 6〜7 周目に私は「述語を入れた後は投げる経路が無いので、境界を消す変異は等価」と
 * 二度主張し、二度とも独立レビューに否定された。実在した経路:
 *
 * | 経路 | 受け皿 |
 * | --- | --- |
 * | `AwsCostPanel` に `{}` → `data.filters.environment` が投げる | `error.tsx`（`/platform` 本体） |
 * | `TenantList` に `{}` → `data.summary.total` が投げる | `error.tsx` |
 * | `or_platform_tenant=%` → `decodeURIComponent` が投げる | **`HeaderErrorBoundary` だけ** |
 *
 * 最後の 1 つは layout が描くヘッダなので `error.tsx` では受けられない。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';
import { HeaderErrorBoundary } from '@/components/admin/platform/HeaderErrorBoundary';
import PlatformError from './error';

const BOOM = Object.assign(new Error('TEST-secret-internal-detail'), { digest: 'TEST-digest' });

describe('運用コンソールの例外画面 (#968)', () => {
  /*
   * 🔴 **運用者の例外に運用者の言葉を出す。** これが無いあいだ、`/platform` の render 例外は
   * `src/app/global-error.tsx` まで上がり、developer に**来訪者向けの 4 言語**
   * 「受付を続けられませんでした。恐れ入りますが、近くのスタッフにお声がけください。」が
   * 出ていた。運用者は原因も再試行の手段も得られず、しかも自分が来訪者画面を見ていると読む。
   */
  it('運用者向けの文言を出す（来訪者向けの文言を出さない）', () => {
    const markup = renderToStaticMarkup(<PlatformError error={BOOM} reset={() => {}} />);
    expect(markup).toContain('data-testid="platform-unexpected-error"');
    expect(markup).toContain('画面を表示できませんでした');
    expect(markup).not.toContain('受付を続けられませんでした');
    expect(markup).not.toContain('スタッフにお声がけ');
  });

  /*
   * 🔴 **例外の本文を画面へ出さない**（`/kiosk` と同じ方針・#629 / #736 Gate A、
   * `.claude/rules/pii-secret-minimization.md`）。`digest` は Next が採番する識別子で
   * PII を含まないので、**これだけ**は出してよい（切り分けに要る）。
   */
  it('🔴 例外の本文を画面へ出さない（digest は出してよい）', () => {
    const markup = renderToStaticMarkup(<PlatformError error={BOOM} reset={() => {}} />);
    expect(markup).not.toContain('TEST-secret-internal-detail');
    expect(markup).toContain('TEST-digest');
  });

  it('🔴 行き止まりにしない（再試行を出す）', () => {
    const markup = renderToStaticMarkup(<PlatformError error={BOOM} reset={() => {}} />);
    expect(markup).toContain('data-testid="platform-unexpected-error-retry"');
  });

  it('digest が無い例外でも落ちない', () => {
    const markup = renderToStaticMarkup(
      <PlatformError error={new Error('TEST-boom')} reset={() => {}} />,
    );
    expect(markup).toContain('data-testid="platform-unexpected-error"');
    expect(markup).not.toContain('TEST-boom');
  });

  it('🔴 境界の実装がログ行の関数を通している（本文を自前で組み立て直さない）', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const path of [
      'src/app/platform/error.tsx',
      'src/components/admin/platform/HeaderErrorBoundary.tsx',
    ]) {
      const source = await readFile(path, 'utf8');
      expect(source, `${path} が unexpectedErrorLogLine を通していない`).toContain(
        'unexpectedErrorLogLine(',
      );
      expect(source, `${path} が例外の本文をログへ渡している`).not.toMatch(
        /console\.(error|warn|log)[^\n]*error\.(message|stack)/,
      );
    }
  });

  it('platform スコープのログ行は digest だけを載せる', () => {
    expect(unexpectedErrorLogLine('platform', BOOM)).toEqual({
      event: 'unexpected_error',
      scope: 'platform',
      digest: 'TEST-digest',
    });
  });
});

/**
 * ヘッダの境界 (#968 レビュー 7 周目 BLOCKER-1 / 8 周目 MAJOR-1・MAJOR-2)。
 *
 * 🔴 `renderToStaticMarkup` は **error boundary を発火させない**（SSR では
 * `getDerivedStateFromError` を経由しない）ので、コンポーネント越しに「子が投げたら
 * fallback が出る」を観測することはできない。だから**状態遷移と描画を直接**叩く。
 * これは `src/app/kiosk/error.test.tsx` が `unexpectedErrorLogLine` を切り出して
 * 直接見ているのと同じ理由である。
 */
describe('ヘッダの境界 (#968)', () => {
  it('通常時は子をそのまま描く', () => {
    const markup = renderToStaticMarkup(
      <HeaderErrorBoundary>
        <span data-testid="child">切替</span>
      </HeaderErrorBoundary>,
    );
    expect(markup).toContain('data-testid="child"');
    expect(markup).not.toContain('platform-header-error');
  });

  it('🔴 子が投げたら fallback へ倒す（状態遷移そのもの）', () => {
    expect(HeaderErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  /*
   * 🔴 **行き止まりにしない (#968 レビュー 8 周目 MAJOR-2)。**
   *
   * 最初の実装は文言だけを返しており、`platform-tenant-switcher`（スコープを変える
   * 唯一の手段）・`platform-viewing-tenant`（#423 の越境警告）・
   * `platform-tenant-list-retry` が**まとめて消えた**。しかも App Router の layout は
   * クライアント遷移で再マウントされないので、**そのセッションのあいだ全画面で
   * 復旧しなかった**。
   */
  it('🔴 fallback に復帰導線と再読込の案内がある', () => {
    const boundary = new HeaderErrorBoundary({ children: null });
    boundary.state = { failed: true, attempt: 0 };
    const markup = renderToStaticMarkup(boundary.render() as React.ReactElement);
    expect(markup).toContain('data-testid="platform-header-error"');
    expect(markup).toContain('data-testid="platform-header-error-retry"');
    expect(markup).toContain('再読み込み');
  });

  /*
   * 🔴 **実装の `onClick` を取り出して叩く。**
   *
   * 最初はテストの中で更新関数を書いて、それを assert していた —— **自分で書いた関数が
   * 自分の期待どおりに動くこと**しか言っておらず、実装をどう変えても緑のままになる。
   * `CLAUDE.md`「自分で導いた述語をそのままテストにすると、テストとコードが同じ誤りを
   * 共有する」の型で、6 周目にも `it.each` で同じことを踏んでいる。
   */
  it('🔴 再試行が失敗状態を解除し、子を作り直す（実装の onClick を叩く）', () => {
    const boundary = new HeaderErrorBoundary({ children: null });
    boundary.state = { failed: true, attempt: 0 };

    let applied: { failed: boolean; attempt: number } | null = null;
    boundary.setState = ((updater: unknown) => {
      applied =
        typeof updater === 'function'
          ? (updater as (p: typeof boundary.state) => typeof boundary.state)(boundary.state)
          : (updater as typeof boundary.state);
    }) as typeof boundary.setState;

    // fallback の要素木から再試行ボタンの onClick を取り出す。
    const el = boundary.render() as React.ReactElement<{ children: React.ReactNode }>;
    const kids = Array.isArray(el.props.children) ? el.props.children.flat() : [el.props.children];
    const button = kids.find(
      (k): k is React.ReactElement<{ onClick: () => void }> =>
        Boolean(k) &&
        typeof k === 'object' &&
        'props' in (k as object) &&
        (k as React.ReactElement<{ 'data-testid'?: string }>).props['data-testid'] ===
          'platform-header-error-retry',
    );
    expect(button, '再試行ボタンが要素木に無い').toBeDefined();

    button?.props.onClick();
    expect(applied, 'onClick が setState を呼んでいない').not.toBeNull();
    // 失敗を解除し、`attempt` を進める（＝ key が変わって子が再マウントされる）。
    expect(applied).toEqual({ failed: false, attempt: 1 });
  });

  it('🔴 通常時の子は attempt を key に持つ（再試行で作り直される）', () => {
    const boundary = new HeaderErrorBoundary({ children: null });
    boundary.state = { failed: false, attempt: 3 };
    const el = boundary.render() as React.ReactElement;
    expect(el.key, '子が attempt を key に持っていない').toBe('3');
  });

  it('🔴 例外の本文を fallback に出さない', () => {
    const boundary = new HeaderErrorBoundary({ children: null });
    boundary.state = { failed: true, attempt: 0 };
    const markup = renderToStaticMarkup(boundary.render() as React.ReactElement);
    expect(markup).not.toContain('TEST-secret-internal-detail');
  });
});
