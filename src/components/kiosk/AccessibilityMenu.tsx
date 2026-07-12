'use client';

import { useState } from 'react';
import { htmlLangFor, makeT, type Locale, type MessageKey } from '@/lib/i18n';
import {
  FONT_SCALES,
  type A11yEnabledModes,
  type FontScale,
} from '@/domain/kiosk/a11y-modes';

/**
 * 常設アクセシビリティ支援モードボタン + パネル (issue #321)。
 *
 * AC「全 kiosk 画面でモード切替が 1〜2 タップで到達できる」を満たすため、KioskFlow の
 * `<main>` 直下に条件分岐の外側で常設する（待機/選択/入力/確認/呼び出し中/結果/PIN許可待ち等、
 * どの画面でも同じ場所に出る）。それ自体が最もアクセシブルであること（AC）を満たすため、
 * 大きなタッチターゲット（`--touch-target-min` 以上）・アイコンと文字の併記・
 * `aria-pressed`/`role="dialog"` などのセマンティクスを持つ。
 *
 * テナント設定で無効化されたモードは `enabledModes` に従いパネルへ出さない（AC）。
 * 状態（フォントスケール・ハイコントラスト・低位置レイアウト・やさしい日本語 locale）は
 * KioskFlow が所有し、本コンポーネントは制御コンポーネントとして値と onChange だけを持つ
 * （既存の LanguageSwitcher / SignageDisplay と同じ設計方針）。
 */
export function AccessibilityMenu({
  fontScale,
  onFontScale,
  highContrast,
  onHighContrast,
  lowReach,
  onLowReach,
  locale,
  onSimpleJapaneseChange,
  enabledModes,
}: {
  fontScale: FontScale;
  onFontScale: (scale: FontScale) => void;
  highContrast: boolean;
  onHighContrast: (value: boolean) => void;
  lowReach: boolean;
  onLowReach: (value: boolean) => void;
  /** 現在の表示 locale（'ja-simple' かどうかでやさしい日本語トグルの状態を判定する）。 */
  locale: Locale;
  /** やさしい日本語トグル。true で 'ja-simple' へ、false で通常表示 locale へ戻す（親が解決する）。 */
  onSimpleJapaneseChange: (enabled: boolean) => void;
  /** テナント/サイト設定でのモードごとの有効/無効 (#321 AC)。無効モードはパネルに出さない。 */
  enabledModes: A11yEnabledModes;
}) {
  const [open, setOpen] = useState(false);
  // パネル自体・ボタンの文言は常に通常表示言語で出す（#321: パネルは bounded scope の対象外。
  // ja-simple 選択中でも既定 ja のパネル文言をそのまま使う＝パネルの可読性を落とさない）。
  const tr = makeT(locale === 'ja-simple' ? 'ja' : locale);
  const simpleJapaneseOn = locale === 'ja-simple';

  const noModesEnabled =
    !enabledModes.largeText && !enabledModes.highContrast && !enabledModes.lowReach && !enabledModes.simpleJapanese;
  if (noModesEnabled) return null;

  return (
    <>
      <button
        type="button"
        className="a11y-menu__button"
        data-testid="a11y-menu-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AccessibilityIcon />
        <span>{tr('a11y.button.label')}</span>
      </button>

      {open ? (
        <div
          className="a11y-menu__overlay"
          data-testid="a11y-menu-overlay"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- パネル内クリックの overlay 閉じ伝播だけを止める（キーボード操作は各コントロールが担う） */}
          <div
            className="a11y-menu__panel"
            data-testid="a11y-menu-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="a11y-menu-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="a11y-menu__header">
              <h2 id="a11y-menu-title" className="a11y-menu__title">
                {tr('a11y.panel.title')}
              </h2>
              <button
                type="button"
                className="a11y-menu__close"
                data-testid="a11y-menu-close"
                onClick={() => setOpen(false)}
              >
                {tr('a11y.panel.close')}
              </button>
            </div>

            {enabledModes.largeText ? (
              <div className="a11y-menu__group">
                <p className="a11y-menu__group-label">{tr('a11y.fontScale.label')}</p>
                <div className="a11y-menu__row" role="group" aria-label={tr('a11y.fontScale.label')}>
                  {FONT_SCALES.map((scale) => (
                    <button
                      key={scale}
                      type="button"
                      className="a11y-menu__option"
                      data-testid={`a11y-font-scale-${scale}`}
                      aria-pressed={fontScale === scale}
                      data-active={fontScale === scale ? 'true' : 'false'}
                      onClick={() => onFontScale(scale)}
                    >
                      {fontScaleLabel(scale, tr)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {enabledModes.highContrast ? (
              <div className="a11y-menu__group">
                <button
                  type="button"
                  className="a11y-menu__toggle"
                  data-testid="a11y-contrast-toggle"
                  aria-pressed={highContrast}
                  data-active={highContrast ? 'true' : 'false'}
                  onClick={() => onHighContrast(!highContrast)}
                >
                  <ContrastIcon />
                  <span>{tr('a11y.contrast.label')}</span>
                </button>
              </div>
            ) : null}

            {enabledModes.lowReach ? (
              <div className="a11y-menu__group">
                <button
                  type="button"
                  className="a11y-menu__toggle"
                  data-testid="a11y-lowreach-toggle"
                  aria-pressed={lowReach}
                  data-active={lowReach ? 'true' : 'false'}
                  onClick={() => onLowReach(!lowReach)}
                >
                  <LowReachIcon />
                  <span>{tr('a11y.lowReach.label')}</span>
                </button>
              </div>
            ) : null}

            {enabledModes.simpleJapanese ? (
              <div className="a11y-menu__group">
                <button
                  type="button"
                  className="a11y-menu__toggle"
                  data-testid="a11y-simple-japanese-toggle"
                  aria-pressed={simpleJapaneseOn}
                  data-active={simpleJapaneseOn ? 'true' : 'false'}
                  lang={htmlLangFor('ja-simple')}
                  onClick={() => onSimpleJapaneseChange(!simpleJapaneseOn)}
                >
                  <SimpleJapaneseIcon />
                  <span>{tr('a11y.simpleJapanese.label')}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function fontScaleLabel(scale: FontScale, tr: (key: MessageKey) => string): string {
  if (scale === '1') return tr('a11y.fontScale.normal');
  if (scale === '1.3') return tr('a11y.fontScale.large');
  return tr('a11y.fontScale.extraLarge');
}

const iconProps = {
  width: 28,
  height: 28,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

/** 汎用アクセシビリティアイコン（人型 + 円、国際的な a11y シンボルの簡略版）。 */
function AccessibilityIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="7.2" r="1.4" />
      <path d="M7 10.2c2.6 1 7.4 1 10 0M12 8.6v5.2l-2 5.4M12 13.8l2 5.4" />
    </svg>
  );
}

function ContrastIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LowReachIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 15h8M8 18h8" />
    </svg>
  );
}

function SimpleJapaneseIcon() {
  return (
    <svg {...iconProps}>
      <path d="M6 5v14M10 5v14M6 12h4M15 6h4M15 6c0 5-1.5 9-4.5 12M19 10c0 4-2 7-4.5 8.5" />
    </svg>
  );
}
