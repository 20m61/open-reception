'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { asCheckoutFailureReason, asCheckoutResolveResult, asPresentStayList } from './parse';
import { resolveReadState } from '@/domain/ui/read-state';
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
  /*
    🔴 **「まだ」「だめだった」「載っている」を混ぜない** ―― `resolveReadState` を使う。

    この増分は `stays` が読めないときの**クラッシュ**を消したが、そこから 2 周かけて
    自分で状態機械を導き直し、**規則を 2 つとも外した**（独立レビュー 3・4 周目）:
      - 「まだ読んでいない」を「0 件」と言い、初回ロード中に
        **「在館中の来訪者はいません。」と断言**していた
      - 再取得が失敗すると、**既に載っている一覧を消して**いた（退館完了 6 秒後の
        `resetToIdentify` が自動で踏む）。失敗が状況を悪化させる形

    どちらも `src/domain/ui/read-state.ts` が #870 で明文化済みだった
    （「載っていることを優先する。再取得が失敗しても既に載っているデータは消さない」）。
    **正解がリポジトリに在るのに手で導き直したのが原因**なので、その述語を使う。
    失敗は消す理由ではなく**添える理由**である。
  */
  const [presentLoaded, setPresentLoaded] = useState(false);
  const [presentFailed, setPresentFailed] = useState(false);
  const [presentBusy, setPresentBusy] = useState(false);
  /** 古い応答で新しい結果を上書きしないための連番（再読み込み連打・回線の追い越し対策）。 */
  const presentSeq = useRef(0);
  const [pending, setPending] = useState<Pending | null>(null);
  // エラーは「理由コード」で保持し、表示時に現在の locale で解決する。
  // これにより (a) 言語切替でエラーも再ローカライズされ、(b) `?ct=`/`?locale=` の
  // 初期化順に依存せず常に選択中 locale の文言になる（tr クロージャの取り違えを防ぐ）。
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * いま往復中の**操作**。`busy` は画面共有のガードなので、`aria-busy` をそれで駆動すると
   * 「別の操作の往復中」に、条件未達で押せないボタンまで**有効な主 CTA の見た目**へ戻る
   * （`?ct=` の自動解決中に空欄の送信ボタン 2 つがシアンの塗りになる, #778 AC3 の再違反）。
   * 進行中表示はそのボタン自身の操作にだけ出す。
   */
  const [inFlight, setInFlight] = useState<'token' | 'code' | 'confirm' | null>(null);
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  const tr = useMemo(() => makeT(locale), [locale]);
  // 「まだ」「だめだった」「載っている」の判断は 1 箇所へ寄せる（#870 の述語を共有）。
  const presentReadState = resolveReadState({ loaded: presentLoaded, failed: presentFailed });
  const error = errorReason ? CHECKOUT_FAILURE_MESSAGE(errorReason, tr) : null;

  // 待機画面の CheckoutLink が付与する `?locale=` を初期値として引き継ぐ（#327）。
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('locale');
    if (isSupportedLocale(fromQuery)) setLocale(fromQuery);
  }, []);

  /*
    🔴 **失敗の文言が画面外に出る問題は、この増分では直さない**（独立レビュー 3 周目 MAJOR-B/C）。

    2 周目に「`errorReason` が付いたらアラートへフォーカスを移す」を入れたが、**それ自体が
    2 つの欠陥を作った**（実測）:
      B. `?ct=` 自動解決の応答が返ったとき、**コード欄に入力中の来訪者からフォーカスを奪う**
         （iPad ではソフトウェアキーボードが閉じる）。期限切れ QR で来た来訪者の
         もっとも自然な回復行動を、割り込みで壊していた
      C. 打ち間違い（**クライアント側検証**の経路。最頻の失敗）は `setErrorReason` が同値なので
         React がベイルアウトし、**2 回目以降は effect が走らない**（サーバ拒否の経路は
         `resolveCredential` 冒頭で `setErrorReason(null)` を挟むので走る）。走ったら走ったで、
         今度は直すべき入力欄が
         フォールドの下（`top=1246`）へ落ちる

    アラートと当該入力欄が**同じビューポートに入らない**のが根 で、スクロールや
    フォーカスの調整では解けない（情報設計の問題）。3 周続けて「直した結果が次の欠陥」に
    なったので、規約どおり**足すのをやめて外す**。#1018 で別に扱う。

    この増分が担うのは「確かめられた 200 だけを載せる」ことであって、失敗表示の配置ではない。
  */

  const loadPresent = useCallback(async () => {
    const seq = ++presentSeq.current;
    // 古い応答が新しい結果を上書きしないよう、自分が最新のときだけ書く。
    const isLatest = (): boolean => presentSeq.current === seq;
    setPresentBusy(true);
    try {
      const res = await fetch('/api/kiosk/checkout');
      if (!res.ok) {
        if (isLatest()) setPresentFailed(true);
        return;
      }
      /*
        🔴 **形を確かめてから載せる**（#1004 増分 2）。`as` は実行時に何も検査しないので、
        `stays` が欠けた 200 で `setPresent(undefined)` が走り、次のレンダーの
        `present.length` が **TypeError → 退館画面ごと落ちる**（`/kiosk/checkout` に
        error boundary は無く、root の `global-error.tsx` が出る）。
      */
      const stays = asPresentStayList(await res.json().catch(() => null));
      if (!isLatest()) return;
      if (stays === null) {
        setPresentFailed(true);
        return;
      }
      setPresent(stays);
      setPresentLoaded(true);
      setPresentFailed(false);
    } catch {
      // 一覧取得の失敗は致命的でない（QR/コードで退館できる）が、**黙らない**。
      if (isLatest()) setPresentFailed(true);
    } finally {
      if (isLatest()) setPresentBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPresent();
  }, [loadPresent]);

  /** resolve API を叩き、成功なら確認画面へ進む。 */
  const resolveCredential = useCallback(
    async (body: Record<string, string>, method: CheckoutMethod, action: 'token' | 'code' | null = null) => {
      if (busy) return;
      setBusy(true);
      setInFlight(action);
      setErrorReason(null);
      try {
        const res = await fetch('/api/kiosk/checkout/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          /*
            🔴 **形を確かめてから進む**（#1004 増分 2）。`summary` が欠けた 200 を通すと
            `pending.summary.checkedInAt` が throw し、**退館の確認画面**（来訪者が
            「退館する」を押す直前）で落ちる。読めなければ確認画面へ進めず、届いてはいるので
            通信を疑わせない文言（`invalid`）で戻す。
          */
          const data = asCheckoutResolveResult(await res.json().catch(() => null));
          if (data === null) {
            /*
              🔴 **`invalid` へ寄せない**（独立レビュー 1 周目 MAJOR-2）。それは
              「受付番号を入力してください」で、(1) 来訪者の入力のせいにし (2) いまの画面に
              無い欄を指し (3) 再試行では直らないのに有人導線が無い。
              加えて `invalid` は**回帰**でもあった ―― 変更前は本文が途中で切れた 200 で
              `res.json()` が reject し、外側の catch が `network` を出していた。
            */
            setErrorReason('unexpected');
            return;
          }
          setPending({ kind: 'credential', method: data.method ?? method, input: body, summary: data.summary });
          setState('confirm');
        } else {
          setErrorReason(asCheckoutFailureReason(await res.json().catch(() => null)));
        }
      } catch {
        setErrorReason('network');
      } finally {
        setBusy(false);
        setInFlight(null);
      }
    },
    [busy],
  );

  // 退館 QR/URL（`?ct=<token>`）で開かれたら自動で解決し確認へ（#98 QR 機構の流用）。
  useEffect(() => {
    const ct = new URLSearchParams(window.location.search).get(CHECKOUT_TOKEN_QUERY);
    if (ct) void resolveCredential({ payload: ct }, 'qr');
    // 初回のみ。resolveCredential は tr/busy に依存するため意図的に依存を絞る。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回のみ実行する意図（resolveCredential は tr/busy に依存する）
  }, []);

  const submitToken = useCallback(() => {
    if (token.trim() === '') return;
    void resolveCredential({ payload: token.trim() }, 'qr', 'token');
  }, [token, resolveCredential]);

  const submitCode = useCallback(() => {
    const normalized = normalizeCheckoutCode(code);
    if (!normalized) {
      setErrorReason('invalid');
      return;
    }
    void resolveCredential({ code: normalized, targetLabel: targetLabel.trim() }, 'code', 'code');
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
    setInFlight('confirm');
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
        setErrorReason(asCheckoutFailureReason(await res.json().catch(() => null)));
        setState('identify');
        setPending(null);
      }
    } catch {
      setErrorReason('network');
      setState('identify');
      setPending(null);
    } finally {
      setBusy(false);
      setInFlight(null);
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
            aria-busy={inFlight === 'confirm'}
          >
            {inFlight === 'confirm' ? tr('common.processing') : tr('checkout.confirm.yes')}
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
            aria-busy={inFlight === 'token'}
          >
            {inFlight === 'token' ? tr('common.processing') : tr('checkout.scanButton')}
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
            aria-busy={inFlight === 'code'}
          >
            {inFlight === 'code' ? tr('common.processing') : tr('checkout.resolveSubmit')}
          </button>
        </section>

        {/* staff 補助: 在館一覧（判別材料 = 時刻 + 呼び出し先 + 用件。氏名は出さない） */}
        <section style={sectionStyle} aria-labelledby="checkout-present-title">
          <h2 id="checkout-present-title" style={sectionTitle}>
            {tr('checkout.presentListTitle')}
          </h2>
          {/*
            🔴 **失敗は「消す理由」ではなく「添える理由」**（独立レビュー 4 周目 MAJOR-1）。
            載っているものがあるなら出したうえで、最新でないことを併記する。
            消してしまうと、再取得の失敗が**状況を悪化させる**（一覧は QR もコードも失くした
            来訪者を staff が照合する唯一の材料で、退館完了 6 秒後の自動リセットでも踏む）。
          */}
          {presentFailed ? (
            <>
              <p data-testid="checkout-present-unavailable" role="status" className="field__label">
                {presentLoaded
                  ? tr('checkout.presentListStale')
                  : tr('checkout.presentListUnavailable')}
              </p>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="checkout-present-retry"
                onClick={() => void loadPresent()}
                /*
                  🔴 **`disabled` は付けない**（独立レビュー 5 周目 MINOR-2）。応答が返らない
                  回線（ブラックホール）だと `finally` に到達せず、**再読み込みが永久に
                  押せなくなる** ―― 4 周目で再入防止のために足した `disabled` が、
                  新しい行き止まりを作っていた。再入そのものは `presentSeq` の連番が
                  既に安全にしている（古い応答は捨てられる）ので、`disabled` は要らない。

                  🔴 **ラベルも「処理しています…」へ変えない**（6 周目 MINOR-2）。押せるのに
                  押せない語で覆うと、消したはずの行き止まりが**見た目の上では残る**。
                  進行中は下の `checkout-present-loading` が live region で伝える
                  （#792 の「処理中≠押せない」）。
                */
                aria-busy={presentBusy}
              >
                {tr('checkout.presentListRetry')}
              </button>
            </>
          ) : null}
          {/*
            🔴 **進行中は初回も再取得も同じ 1 行で伝える**（6 周目 MINOR-3）。#870 の正本
            （`src/components/admin/ui/DataTable.tsx`）は loading も failed も
            `role="status" aria-live="polite"` を持つ。ここだけ黙っていると、iPad +
            VoiceOver の staff に「確認しています…」も「一覧が出た」も一度も読み上げられない。
          */}
          {presentReadState === 'loading' || presentBusy ? (
            <p
              data-testid="checkout-present-loading"
              role="status"
              aria-live="polite"
              className="field__label"
            >
              {tr('checkout.presentListLoading')}
            </p>
          ) : null}
          {presentReadState !== 'loaded' ? null : present.length === 0 ? (
            /*
              🔴 **「0 件を読めている」ことも載っているデータである**（6 周目 MINOR-1）。
              5 周目は再取得に失敗したら断言しないよう**何も出さなく**したが、それだと上の
              「表示は前回時点のものです」が**指す先の無い文言**になり、画面と矛盾する
              （「前回は 0 名」なのか「そもそも出せていない」のか staff に区別できない）。
              消すのではなく、前回時点の話であると明示した文言へ寄せる。
            */
            presentFailed ? (
              <p data-testid="checkout-empty-stale" role="status" className="field__label">
                {tr('checkout.presentListStaleEmpty')}
              </p>
            ) : (
              <p data-testid="checkout-empty" className="field__label">
                {tr('checkout.emptyPresent')}
              </p>
            )
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
