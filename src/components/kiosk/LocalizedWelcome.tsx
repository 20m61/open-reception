'use client';

import { useState } from 'react';
import { DEFAULT_LOCALE, makeT, type Locale } from '@/lib/i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

/**
 * 多言語 welcome 画面の適用例 (issue #103, increment 1)。
 *
 * 目的: i18n 基盤（makeT / LanguageSwitcher）の使い方を限定的に示すスタンドアロン例。
 * KioskFlow へは組み込まない（既存全文言の一括差し替えは次増分。対応表は
 * docs/i18n-tts-design.md §全文言移行計画）。
 *
 * ここでは locale 状態をローカルに持ち、選択に応じて主要文言を切り替える。実配線時は
 * locale を受付状態機械／設定（既定言語）から受け取る形にする。
 */
export function LocalizedWelcome({ initialLocale = DEFAULT_LOCALE }: { initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const tr = makeT(locale);
  return (
    <section style={sectionStyle}>
      <LanguageSwitcher locale={locale} onChange={setLocale} label={tr('welcome.chooseLanguage')} />
      <h1 lang={locale} style={titleStyle}>
        {tr('welcome.title')}
      </h1>
      <p lang={locale} style={leadStyle}>
        {tr('welcome.tapToStart')}
      </p>
      <p lang={locale} style={noticeStyle}>
        {tr('voice.fallbackNotice')}
      </p>
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  padding: 32,
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = { margin: 0, fontSize: 40, fontWeight: 700 };
const leadStyle: React.CSSProperties = { margin: 0, fontSize: 24 };
const noticeStyle: React.CSSProperties = { margin: 0, fontSize: 16, color: 'var(--color-muted, #666)' };
