'use client';

import {
  LOCALE_NATIVE_LABEL,
  SUPPORTED_LOCALES,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n';

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
        {SUPPORTED_LOCALES.map((value) => {
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

const buttonStyle: React.CSSProperties = {
  minWidth: 120,
  minHeight: 56,
  padding: '12px 24px',
  fontSize: 20,
  borderRadius: 12,
  border: '2px solid var(--color-border, #ccc)',
  background: 'var(--color-surface, #fff)',
  color: 'var(--color-text, #111)',
  cursor: 'pointer',
};

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--color-accent, #2563eb)',
  background: 'var(--color-accent, #2563eb)',
  color: '#fff',
  fontWeight: 700,
};
