'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  htmlLangFor,
  isSupportedLocale,
  makeT,
  type Locale,
} from '@/lib/i18n';
import { LanguageSwitcher } from '../LanguageSwitcher';
import {
  CHECKOUT_FAILURE_MESSAGE,
  type CheckoutMethod,
  type CheckoutSelfIdSummary,
  type PresentStaySummary,
} from './logic';
import { CHECKOUT_TOKEN_QUERY, normalizeCheckoutCode } from './self-id';

/**
 * 受付端末の退館チェックアウトフロー — 自己特定 再設計 (issue #328、#102/#327 の上に再設計)。
 *
 * 旧実装の「受付番号（内部 stayId）直入力前提」を解消し、来訪者が **ID を記憶せず**退館できる
 * 導線にする（docs/checkout-stay-design.md §8）:
 *   1. identify: 退館 QR（token）をかざす/貼り付け、または 短い退館コード + 呼び出し先ラベルを入力
 *      （staff 補助として在館一覧からも選べる。氏名は出さない）。
 *   2. confirm: 「◯時◯分に △△ 宛でご来館の方ですか？」＋用件を提示し本人確認（PII なし）。
 *   3. done: 「退館を受け付けました」のみ表示し、一定時間で入力へ戻る（PII を残さない）。
 *
 * 見た目は受付フローと同一のデザイン言語（.screen/.btn/.field/.input・逃げ道バー・64px タッチ）に統一。
 * 退館 QR/URL（`?ct=<token>`）で開かれた場合は自動で解決し確認へ進む（#98 の QR 機構を流用）。
 *
 * **locale (#327)**: 待機画面の CheckoutLink が付与する `?locale=` を初期値に引き継ぎ、直接来た
 * 来訪者のためにも LanguageSwitcher を出す。文言は i18n カタログが正（生 CJK を書かない = #327 CJK lint）。
 */

/** 完了画面の自動リセット時間（ミリ秒）。 */
const RESET_DELAY_MS = 6000;

/** 受付時刻表示用の Intl locale（時刻表示専用の軽量マップ）。 */
const TIME_FORMAT_LOCALE: Record<Locale, string> = {
  ja: 'ja-JP',
  en: 'en-US',
  ko: 'ko-KR',
  zh: 'zh-CN',
  'ja-simple': 'ja-JP',
};

type FlowState = 'identify' | 'confirm' | 'done';

/** 確認画面へ渡す保留中の退館（自己特定 or staff の在館一覧選択）。 */
type Pending = {
  summary: CheckoutSelfIdSummary;
} & (
  | { kind: 'credential'; method: CheckoutMethod; input: Record<string, string> }
  | { kind: 'stay'; stayId: string }
);

export function CheckoutFlow() {
  const [state, setState] = useState<FlowState>('identify');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [present, setPresent] = useState<PresentStaySummary[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // エラーは「理由コード」で保持し、表示時に現在の locale で解決する。
  // これにより (a) 言語切替でエラーも再ローカライズされ、(b) `?ct=`/`?locale=` の
  // 初期化順に依存せず常に選択中 locale の文言になる（tr クロージャの取り違えを防ぐ）。
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  const tr = useMemo(() => makeT(locale), [locale]);
  const error = errorReason ? CHECKOUT_FAILURE_MESSAGE(errorReason, tr) : null;

  // 待機画面の CheckoutLink が付与する `?locale=` を初期値として引き継ぐ（#327）。
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('locale');
    if (isSupportedLocale(fromQuery)) setLocale(fromQuery);
  }, []);

  const loadPresent = useCallback(async () => {
    try {
      const res = await fetch('/api/kiosk/checkout');
      if (res.ok) {
        const data = (await res.json()) as { stays: PresentStaySummary[] };
        setPresent(data.stays);
      }
    } catch {
      // 一覧取得失敗は致命的でない（QR/コードで退館できる）。
    }
  }, []);

  useEffect(() => {
    void loadPresent();
  }, [loadPresent]);

  /** resolve API を叩き、成功なら確認画面へ進む。 */
  const resolveCredential = useCallback(
    async (body: Record<string, string>, method: CheckoutMethod) => {
      if (busy) return;
      setBusy(true);
      setErrorReason(null);
      try {
        const res = await fetch('/api/kiosk/checkout/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as { method: CheckoutMethod; summary: CheckoutSelfIdSummary };
          setPending({ kind: 'credential', method: data.method ?? method, input: body, summary: data.summary });
          setState('confirm');
        } else {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setErrorReason(data?.error ?? 'network');
        }
      } catch {
        setErrorReason('network');
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // 退館 QR/URL（`?ct=<token>`）で開かれたら自動で解決し確認へ（#98 QR 機構の流用）。
  useEffect(() => {
    const ct = new URLSearchParams(window.location.search).get(CHECKOUT_TOKEN_QUERY);
    if (ct) void resolveCredential({ payload: ct }, 'qr');
    // 初回のみ。resolveCredential は tr/busy に依存するため意図的に依存を絞る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitToken = useCallback(() => {
    if (token.trim() === '') return;
    void resolveCredential({ payload: token.trim() }, 'qr');
  }, [token, resolveCredential]);

  const submitCode = useCallback(() => {
    const normalized = normalizeCheckoutCode(code);
    if (!normalized) {
      setErrorReason('invalid');
      return;
    }
    void resolveCredential({ code: normalized, targetLabel: targetLabel.trim() }, 'code');
  }, [code, targetLabel, resolveCredential]);

  /** 在館一覧（staff 補助）から選ぶ。判別材料を持つ確認画面へ進む。 */
  const selectPresent = useCallback((s: PresentStaySummary) => {
    setErrorReason(null);
    setPending({
      kind: 'stay',
      stayId: s.stayId,
      summary: {
        checkedInAt: s.checkedInAt,
        targetLabel: s.targetLabel ?? '',
        purpose: s.purpose ?? '',
      },
    });
    setState('confirm');
  }, []);

  /** 確認画面で「はい」→ 退館確定。 */
  const confirmCheckout = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    setErrorReason(null);
    try {
      const res =
        pending.kind === 'credential'
          ? await fetch('/api/kiosk/checkout/confirm', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(pending.input),
            })
          : await fetch('/api/kiosk/checkout', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ stayId: pending.stayId }),
            });
      if (res.ok) {
        setState('done');
        setPending(null);
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrorReason(data?.error ?? 'network');
        setState('identify');
        setPending(null);
      }
    } catch {
      setErrorReason('network');
      setState('identify');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }, [pending, busy]);

  const resetToIdentify = useCallback(() => {
    setState('identify');
    setPending(null);
    setToken('');
    setCode('');
    setTargetLabel('');
    setErrorReason(null);
    void loadPresent();
  }, [loadPresent]);

  // 完了後に入力画面へ自動で戻す（PII を残さない）。
  useEffect(() => {
    if (state !== 'done') return;
    const timer = setTimeout(resetToIdentify, RESET_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, resetToIdentify]);

  // ---- 画面 ----

  if (state === 'done') {
    return (
      <main className="screen" data-testid="checkout-done" lang={htmlLangFor(locale)}>
        <div className="screen__body" style={centeredCard}>
          <h1 className="screen__title">{tr('checkout.doneTitle')}</h1>
          <p className="screen__lead">{tr('checkout.doneBody')}</p>
        </div>
        <EscapeBar tr={tr} onStartOver={resetToIdentify} />
      </main>
    );
  }

  if (state === 'confirm' && pending) {
    const time = formatTime(pending.summary.checkedInAt, locale);
    const target = pending.summary.targetLabel.trim() || tr('checkout.targetUnknown');
    const purpose = pending.summary.purpose.trim() || tr('checkout.purposeUnknown');
    return (
      <main className="screen" data-testid="checkout-confirm" lang={htmlLangFor(locale)}>
        <div style={switcherRow}>
          <LanguageSwitcher locale={locale} onChange={setLocale} />
        </div>
        <div className="screen__body">
          <h1 className="screen__title">{tr('checkout.confirm.title')}</h1>
          <p className="screen__lead">{tr('checkout.confirm.lead')}</p>
          <p data-testid="checkout-confirm-question" style={questionStyle}>
            {tr('checkout.confirm.question', { time, target })}
          </p>
          <dl style={detailList}>
            <DetailRow label={tr('checkout.confirm.timeLabel')} value={time} />
            <DetailRow label={tr('checkout.confirm.targetLabel')} value={target} />
            <DetailRow label={tr('checkout.confirm.purposeLabel')} value={purpose} />
          </dl>
          {error ? (
            <p data-testid="checkout-error" role="alert" className="notice" style={errorStyle}>
              {error}
            </p>
          ) : null}
        </div>
        <div className="screen__footer">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="checkout-confirm-yes"
            onClick={() => void confirmCheckout()}
            disabled={busy}
          >
            {tr('checkout.confirm.yes')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="checkout-confirm-no"
            onClick={resetToIdentify}
            disabled={busy}
          >
            {tr('checkout.confirm.no')}
          </button>
        </div>
      </main>
    );
  }

  // identify
  return (
    <main className="screen" lang={htmlLangFor(locale)}>
      <div style={switcherRow}>
        <LanguageSwitcher locale={locale} onChange={setLocale} />
      </div>
      <div className="screen__body">
        <h1 className="screen__title">{tr('checkout.title')}</h1>
        <p className="screen__lead">{tr('checkout.lead')}</p>

        {error ? (
          <p data-testid="checkout-error" role="alert" className="notice" style={errorStyle}>
            {error}
          </p>
        ) : null}

        {/* 退館 QR / token 経路 */}
        <section style={sectionStyle} aria-labelledby="checkout-token-title">
          <h2 id="checkout-token-title" style={sectionTitle}>
            {tr('checkout.tokenSectionTitle')}
          </h2>
          <p className="field__label">{tr('checkout.tokenSectionHint')}</p>
          <div className="field">
            <label className="field__label" htmlFor="checkout-token">
              {tr('checkout.tokenLabel')}
            </label>
            <input
              id="checkout-token"
              data-testid="checkout-token"
              className="input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tr('checkout.tokenPlaceholder')}
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="checkout-token-submit"
            onClick={submitToken}
            disabled={busy || token.trim() === ''}
          >
            {tr('checkout.scanButton')}
          </button>
        </section>

        <div style={dividerStyle} aria-hidden="true">
          {tr('checkout.or')}
        </div>

        {/* 短コード + 呼び出し先ラベル経路 */}
        <section style={sectionStyle} aria-labelledby="checkout-code-title">
          <h2 id="checkout-code-title" style={sectionTitle}>
            {tr('checkout.codeSectionTitle')}
          </h2>
          <p className="field__label">{tr('checkout.codeSectionHint')}</p>
          <div className="field">
            <label className="field__label" htmlFor="checkout-code">
              {tr('checkout.codeLabel')}
            </label>
            <input
              id="checkout-code"
              data-testid="checkout-code"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={tr('checkout.codePlaceholder')}
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="checkout-target-label">
              {tr('checkout.targetLabelLabel')}
            </label>
            <input
              id="checkout-target-label"
              data-testid="checkout-target-label"
              className="input"
              value={targetLabel}
              onChange={(e) => setTargetLabel(e.target.value)}
              placeholder={tr('checkout.targetLabelPlaceholder')}
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="checkout-resolve-submit"
            onClick={submitCode}
            disabled={busy || code.trim() === '' || targetLabel.trim() === ''}
          >
            {tr('checkout.resolveSubmit')}
          </button>
        </section>

        {/* staff 補助: 在館一覧（判別材料 = 時刻 + 呼び出し先 + 用件。氏名は出さない） */}
        <section style={sectionStyle} aria-labelledby="checkout-present-title">
          <h2 id="checkout-present-title" style={sectionTitle}>
            {tr('checkout.presentListTitle')}
          </h2>
          {present.length === 0 ? (
            <p data-testid="checkout-empty" className="field__label">
              {tr('checkout.emptyPresent')}
            </p>
          ) : (
            <ul data-testid="checkout-present-list" style={listStyle}>
              {present.map((s) => (
                <li key={s.stayId} style={listItemStyle}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span>{tr('checkout.checkedInAt', { time: formatTime(s.checkedInAt, locale) })}</span>
                    <span className="field__label">
                      {(s.targetLabel?.trim() || tr('checkout.targetUnknown')) +
                        ' / ' +
                        (s.purpose?.trim() || tr('checkout.purposeUnknown'))}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="checkout-present-item"
                    onClick={() => selectPresent(s)}
                    disabled={busy}
                  >
                    {tr('checkout.checkoutButton')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <EscapeBar tr={tr} onStartOver={resetToIdentify} />
    </main>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={detailRow}>
      <dt className="field__label" style={{ margin: 0 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontWeight: 700 }}>{value}</dd>
    </div>
  );
}

function EscapeBar({
  tr,
  onStartOver,
}: {
  tr: (key: 'checkout.startOver') => string;
  onStartOver: () => void;
}) {
  return (
    <nav className="kiosk-escape-bar" aria-label={tr('checkout.startOver')}>
      <button
        type="button"
        className="btn btn--ghost"
        data-testid="checkout-start-over"
        onClick={onStartOver}
      >
        {tr('checkout.startOver')}
      </button>
    </nav>
  );
}

function formatTime(iso: string, locale: Locale): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleTimeString(TIME_FORMAT_LOCALE[locale], { hour: '2-digit', minute: '2-digit' });
}

// ---- レイアウト微調整（globals.css のトークン/クラスを尊重。CSS ファイルは編集しない #329） ----

const switcherRow: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end' };
const centeredCard: React.CSSProperties = {
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const sectionTitle: React.CSSProperties = { fontSize: '1.15rem', margin: 0, fontWeight: 800 };
const dividerStyle: React.CSSProperties = {
  textAlign: 'center',
  opacity: 0.6,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};
const questionStyle: React.CSSProperties = { fontSize: '1.4rem', fontWeight: 800, lineHeight: 1.35 };
const detailList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, margin: 0 };
const detailRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  paddingBottom: 8,
  // #329: 白ボーダー収れん（0.1 → --color-border=0.08、承認済み α 差分）。
  borderBottom: '1px solid var(--color-border)',
};
const errorStyle: React.CSSProperties = { color: 'var(--color-danger)', fontWeight: 700 };
const listStyle: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const listItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 0',
  // #329: 白ボーダー収れん（0.1 → --color-border=0.08、承認済み α 差分）。
  borderBottom: '1px solid var(--color-border)',
};
