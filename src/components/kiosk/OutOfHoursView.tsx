'use client';

/**
 * 営業時間外の待機画面 (issue #367 の kiosk 表示レール / #363 injection point 1)。
 *
 * `resolveKioskMode` が営業状態注入（`operatingStatus`）から 'out_of_hours' を返したときに、
 * 通常のサイネージ/受付フローの代わりに表示する。構成:
 *   - 来訪者向け案内（営業時間外である旨と再来のお願い）
 *   - 再開時刻の表示枠（reopenAt があれば locale 整形、無ければ汎用文言）
 *   - 緊急連絡導線プレースホルダ（ラベル + 表示文言のみ。実連絡先/PII は載せない #367 で接続）
 *   - 言語切替（i18n 4 言語対応）
 *
 * fail-open: 営業状態が不明なときはそもそもこの画面に到達しない（通常受付）。ここは「閉店」が
 * 確定したときの表示専用で、状態機械（ReceptionState）や受付進行には一切干渉しない。
 */
import { LanguageSwitcher } from './LanguageSwitcher';
import { makeT, htmlLangFor, type Locale } from '@/lib/i18n';
import { parseReopenAt, type KioskOperatingStatus } from '@/domain/kiosk/operating-status';

/** 日付整形用の locale → BCP47（TTS 用コードとは別に、Intl 表示に適した値を使う）。 */
const INTL_LOCALE: Record<Locale, string> = {
  ja: 'ja-JP',
  en: 'en-US',
  ko: 'ko-KR',
  zh: 'zh-CN',
  'ja-simple': 'ja-JP',
};

/**
 * reopenAt を整形する。`timezone`（営業時間ポリシーの IANA TZ）が渡されればそれで整形し、
 * 未指定時は従来どおり端末 TZ（`Intl` 既定）にフォールバックする（#367 polish）。
 * 端末が UTC で運用されうる（kiosk 端末の TZ 設定は保証されない）ため、ポリシー TZ を優先しないと
 * 09:00 JST の再開時刻が 0:00 と表示される不整合が起きる。
 */
export function formatReopen(iso: string | undefined, locale: Locale, timezone?: string): string | null {
  const ms = parseReopenAt(iso);
  if (ms === null) return null;
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  if (timezone) {
    // TZ 名はサーバ検証済みだが、ブラウザ ICU 差や検証導入前の旧ポリシー値で RangeError に
    // なり得る。無人端末で描画を落とさないため、失敗時は端末 TZ へフォールバックする(fail-safe)。
    try {
      return new Intl.DateTimeFormat(INTL_LOCALE[locale], { ...options, timeZone: timezone }).format(
        new Date(ms),
      );
    } catch {
      // fall through
    }
  }
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], options).format(new Date(ms));
}

export type OutOfHoursViewProps = {
  status: KioskOperatingStatus;
  locale: Locale;
  /** 言語切替（任意）。渡すと 4 言語スイッチャを表示する。 */
  onLocaleChange?: (next: Locale) => void;
};

export function OutOfHoursView({ status, locale, onLocaleChange }: OutOfHoursViewProps): React.ReactElement {
  const tr = makeT(locale);
  const lang = htmlLangFor(locale);
  const reopenText = formatReopen(status.reopenAt, locale, status.timezone);

  return (
    <div
      className="screen__body"
      data-testid="kiosk-out-of-hours"
      style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 'var(--space-lg)' }}
    >
      <h1 className="screen__title" lang={lang}>
        {tr('kiosk.outOfHours.title')}
      </h1>
      <p className="screen__lead" lang={lang} data-testid="kiosk-out-of-hours-lead">
        {tr('kiosk.outOfHours.lead')}
      </p>

      <div className="notice" data-testid="kiosk-out-of-hours-reopen" lang={lang}>
        <span className="card__sub">{tr('kiosk.outOfHours.reopenLabel')}</span>
        {reopenText ? (
          <p style={{ margin: 0, fontSize: 'var(--font-lg)' }} data-testid="kiosk-out-of-hours-reopen-time">
            {reopenText}
          </p>
        ) : (
          <p style={{ margin: 0 }} data-testid="kiosk-out-of-hours-reopen-unknown">
            {tr('kiosk.outOfHours.reopenUnknown')}
          </p>
        )}
      </div>

      {/* 緊急連絡導線プレースホルダ。実連絡先・PII は載せない（#367 で運用ポリシーに沿って接続）。 */}
      <div className="notice notice--warning" data-testid="kiosk-out-of-hours-emergency" lang={lang}>
        <span className="card__sub">{tr('kiosk.outOfHours.emergencyLabel')}</span>
        <p style={{ margin: 0 }}>
          {status.emergencyContactLabel ?? tr('kiosk.outOfHours.emergencyPlaceholder')}
        </p>
      </div>

      {onLocaleChange ? (
        <div data-testid="kiosk-out-of-hours-language">
          <LanguageSwitcher locale={locale} onChange={onLocaleChange} />
        </div>
      ) : null}
    </div>
  );
}
