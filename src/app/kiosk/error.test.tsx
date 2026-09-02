/**
 * 予期しない例外で来訪者へ生の技術的エラーを出さない (#736 Gate A / #629 と同じ方針)。
 *
 * ## 事実（修正前）
 *
 * `src/app` にエラー境界が**一つも無かった**（`error.tsx` / `global-error.tsx` /
 * React の `componentDidCatch` とも 0 件）。`KioskFlow` の中で未捕捉例外が 1 つでも起きると、
 * iPad には Next 既定の **"Application error: a client-side exception has occurred"** が
 * 英語で出る。
 *
 * 「劣化しても止めない」設計（音声・カメラ・アバターが全滅してもタッチで完走できる）が、
 * **React のレンダー例外という単一障害点で無効化されていた**。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '@/lib/i18n';
import { UnexpectedErrorScreen } from '@/components/kiosk/UnexpectedErrorScreen';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';
import KioskError from './error';
import GlobalError from '../global-error';

const BOOM = Object.assign(new Error('TEST-secret-internal-detail'), { digest: 'TEST-digest' });

describe('予期しない例外の画面 (#736)', () => {
  it('来訪者向けの案内を出す', () => {
    const markup = renderToStaticMarkup(<UnexpectedErrorScreen />);
    expect(markup).toContain('data-testid="kiosk-unexpected-error"');
    expect(markup).toContain(makeT('ja')('kiosk.unexpectedError.title'));
  });

  /**
   * 🔴 **例外の内容を画面へ出さない。** 来訪者には読めないし、内部の構造が漏れる。
   */
  it('🔴 例外の本文・digest を画面へ出さない', () => {
    const markup = renderToStaticMarkup(<KioskError error={BOOM} reset={() => {}} />);
    expect(markup).not.toContain('TEST-secret-internal-detail');
    expect(markup).not.toContain('TEST-digest');
    expect(markup).not.toContain('Error');
  });

  it('🔴 行き止まりにしない（再試行を出す）', () => {
    const markup = renderToStaticMarkup(<KioskError error={BOOM} reset={() => {}} />);
    expect(markup).toContain('data-testid="kiosk-unexpected-error-retry"');
  });

  /**
   * 言語判定をしない ── 例外が起きた文脈では locale の状態も信用できない。
   */
  it('4 言語を並べる', () => {
    const markup = renderToStaticMarkup(<UnexpectedErrorScreen />);
    for (const lang of ['ja', 'en', 'ko', 'zh']) {
      expect(markup, `${lang} が無い`).toContain(`lang="${lang}"`);
    }
  });
});

describe('ルートレイアウトまで壊れたとき (#736)', () => {
  /**
   * `error.tsx` は自分のセグメントより下しか拾えない。**レイアウト自身が落ちると通らない**。
   */
  it('自前の html/body を描く（Next の契約）', () => {
    const markup = renderToStaticMarkup(<GlobalError error={BOOM} />);
    expect(markup).toContain('<html');
    expect(markup).toContain('<body');
  });

  /**
   * 🔴 **外部リソースを参照しない。** ここへ来る時点で CSS もフォントも読めていない
   * 可能性がある（`service-hold-page.ts` と同じ理由）。
   */
  it('🔴 外部リソースを読み込まない', () => {
    const markup = renderToStaticMarkup(<GlobalError error={BOOM} />);
    expect(markup).not.toContain('<link');
    expect(markup).not.toContain('<script');
    expect(markup).not.toMatch(/https?:\/\//);
  });

  it('🔴 例外の内容を出さない', () => {
    const markup = renderToStaticMarkup(<GlobalError error={BOOM} />);
    expect(markup).not.toContain('TEST-secret-internal-detail');
    expect(markup).not.toContain('TEST-digest');
  });

  it('4 言語を並べる', () => {
    const markup = renderToStaticMarkup(<GlobalError error={BOOM} />);
    for (const lang of ['ja', 'en', 'ko', 'zh']) {
      expect(markup, `${lang} が無い`).toContain(`lang="${lang}"`);
    }
  });
});

describe('切り分けの手掛かりは残す (#736)', () => {
  /**
   * 画面に出さないぶん、**ログには digest を残す**。無いと「iPad が固まった」通報に対して
   * 何も手掛かりが無くなる。
   *
   * 🔴 ここは**ログ行を組み立てる関数を直接**見る。コンポーネント越しに見ようとすると
   * `useEffect` が SSR で走らないため、実装が本文や stack を載せる変異を**素通りさせる**
   * （実測済み）。だから `unexpectedErrorLogLine` を切り出してある。
   */
  it('digest だけを載せる', () => {
    expect(unexpectedErrorLogLine('kiosk', BOOM)).toEqual({
      event: 'unexpected_error',
      scope: 'kiosk',
      digest: 'TEST-digest',
    });
  });

  it('🔴 例外の本文・stack を載せない', () => {
    const line = JSON.stringify(unexpectedErrorLogLine('app', BOOM));
    expect(line).not.toContain('TEST-secret-internal-detail');
    expect(line).not.toContain('stack');
  });

  it('digest が無い例外でも落ちない', () => {
    expect(unexpectedErrorLogLine('kiosk', new Error('TEST-boom')).digest).toBeNull();
  });

  /** 空文字を digest として載せない（`??` では '' がそのまま通る）。 */
  it('digest が空文字なら無しとして扱う', () => {
    expect(unexpectedErrorLogLine('app', { digest: '' }).digest).toBeNull();
  });

  /**
   * 境界そのものが実際にこの関数を通していることを縛る。
   * `error.tsx` が独自に本文を組み立て直すと、上の性質は守られない。
   */
  it('🔴 境界の実装がこの関数を使っている', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const path of ['src/app/kiosk/error.tsx', 'src/app/global-error.tsx']) {
      const source = await readFile(path, 'utf8');
      expect(source, `${path} が unexpectedErrorLogLine を通していない`).toContain(
        'unexpectedErrorLogLine(',
      );
      expect(source, `${path} が例外の本文をログへ渡している`).not.toMatch(
        /console\.(error|warn|log)[^\n]*error\.(message|stack)/,
      );
    }
  });
});
