'use client';

import {
  LOCALE_NATIVE_LABEL,
  SUPPORTED_LOCALES,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n';

/**
 * 通常の言語選択に出す locale（#321: 'ja-simple' はここには出さない）。
 * やさしい日本語は「表示言語の切替」ではなくアクセシビリティ支援モードの 1 つとして扱い、
 * 専用の支援モードパネル（AccessibilityMenu）からのみ選ばせる（AC「1〜2タップ」の到達点を
 * 一本化し、通常の言語一覧に紛れさせない）。
 */
const DISPLAY_LOCALES = SUPPORTED_LOCALES.filter((value) => value !== 'ja-simple');

/**
 * 受付の言語切替 (issue #103, increment 1)。
 *
 * スタンドアロン: KioskFlow へは組み込まない（配線は後増分でオーケストレータが行う）。
 * 各 locale の表示名は自言語固定ラベル（LOCALE_NATIVE_LABEL）で出す＝翻訳に依存せず、
 * 読めない言語でも自分の言語を見つけられる (#103 UX 方針)。
 *
 * 制御コンポーネント: 現在 locale と onChange を親が持つ。状態を内部に持たないことで
 * KioskFlow への配線時に受付状態機械へ委譲しやすくする（SignageDisplay の onStart と同方針）。
 *
 * アクセシビリティ / iPad: ボタンは大きめ・余白広め、横折返し可（#103: ボタン幅と改行に余裕）。
 */
export function LanguageSwitcher({
  locale,
  onChange,
  label,
}: {
  /** 現在選択中の locale。未対応値は既定へ正規化して表示する。 */
  locale: Locale;
  onChange: (next: Locale) => void;
  /** 見出し（任意）。受付開始前の言語選択画面では t('welcome.chooseLanguage') を渡す想定。 */
  label?: string;
}) {
  const current = normalizeLocale(locale);
  return (
    <div role="group" aria-label={label ?? 'Language'} style={groupStyle}>
      {label ? <p style={labelStyle}>{label}</p> : null}
      <div style={listStyle}>
        {DISPLAY_LOCALES.map((value) => {
          const active = value === current;
          return (
            <button
              key={value}
              type="button"
              lang={value}
              aria-pressed={active}
              onClick={() => onChange(value)}
              style={active ? activeButtonStyle : buttonStyle}
            >
              {LOCALE_NATIVE_LABEL[value]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const labelStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
};

// #329: CSS 変数は globals.css :root に常に定義されているため生値フォールバックは不要
// （フォールバックは実際には使われない＝除去しても描画は不変）。単一ソース化のため除去。
const buttonStyle: React.CSSProperties = {
  minWidth: 120,
  minHeight: 56,
  padding: '12px 24px',
  fontSize: 20,
  borderRadius: 12,
  border: '2px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--color-accent)',
  background: 'var(--color-accent)',
  /*
   * #321: 既定アクセント色（--brand-accent #38bdf8）上で --color-on-accent（白）を使うと
   * コントラスト比が約 2.1:1 しか出ず axe の color-contrast（serious）に抵触する。
   * `.btn--primary` と同じ確立済みパターン（アクセント上は --color-accent-ink、比 8.8:1）へ揃える。
   * #329 時点の exact value 保存（元の白インク）より a11y 適合を優先する。
   */
  color: 'var(--color-accent-ink)',
  fontWeight: 700,
};
