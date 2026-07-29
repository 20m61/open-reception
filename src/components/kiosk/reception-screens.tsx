/**
 * 受付ジャーニーの画面群 (issue #422 increment 4)。
 *
 * `KioskFlow` から切り出した**描画だけ**の層。副作用（構成取得・heartbeat・メトリクス）は
 * `useKioskConfiguration` / `useKioskDeviceStatus` / `useExperienceMetrics` が、状態遷移は
 * `flow-state.ts` が持つ。ここに在るのは「その状態をどう見せるか」だけで、fetch もタイマーも
 * 持たない（持たせないこと。分割が巻き戻る）。
 *
 * 文言はすべて i18n 辞書（`makeT`）経由で、**生の日本語リテラルを置かない**。
 * `KioskFlow.tsx` は #327 の allowlist に載っているが本ファイルは載っておらず、
 * `scripts/check-cjk-literals.ts` が全リテラルを検査する（＝新規文言の翻訳漏れが構造的に落ちる）。
 */
'use client';

// 代替導線を出すかの判断（`shouldOfferAlternativeContact`）はここから消えた (#422 inc5-b
// 増分 2)。契約 `conversationTurnFor` が `callFailureReason` を見て回答を返すので、画面は
// 返ってきたものを描くだけになった。判断の二重実装を残さない。
import {
  failedMessageKeyFor,
  type CallFailureReason,
} from '@/domain/reception/call-failure';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
// 用件の一覧（`RECEPTION_PURPOSES`）もここから消えた (#422 inc5-b 増分 3a)。
// どの用件をどの順で出すかは契約が決め、画面はアイコンと説明文だけを足す。
import {
  type ReceptionPurposeId,
  type VisitorInfo,
} from '@/domain/reception/session';
import type {
  FeedbackReasonCode,
  SatisfactionRating,
} from '@/domain/reception/log';
import {
  type Action,
  type CheckoutCredential,
  type FlowData,
  type Target,
} from './flow-state';
import {
  AvatarGuide,
} from './avatar/AvatarGuide';
import {
  LanguageSwitcher,
} from './LanguageSwitcher';
import {
  makeT,
  DEFAULT_LOCALE,
  htmlLangFor,
  type Locale,
  type MessageKey,
} from '@/lib/i18n';
import {
  quickActionIcon,
  purposeIcon,
} from './quick-action-icons';
import {
  hasBrandingContent,
  type BrandingSettings,
} from '@/domain/branding/types';
import {
  resultToneForState,
  type ResultTone,
} from './result-tone';
import {
  resolvePrivacyNoticeContent,
} from './privacy-notice';
import type {
  QuickActionIntent,
} from './quick-actions';
import {
  screenTitleFor,
  turnAnswersFor,
  turnHandoffsFor,
  type TurnAnswerView,
  type TurnHandoffView,
} from './conversation-turn';
import type {
  ReceptionState,
} from '@/domain/reception/ui-contract';
import {
  KioskCallView,
} from './KioskCallView';

import type {
  StaffResponseResult,
} from '@/domain/reception/staff-response';
import {
  defaultSttAdapterFactory,
  type SttAdapterFactory,
} from './stt-adapter';
import {
  type CallStage,
} from '@/domain/kiosk/call-stages';
import {
  buildCheckoutUrl,
  safeCheckoutQrDataUrl,
} from './checkout/credential-display';
import {
  searchStaffScored,
} from '@/domain/staff/search';
import {
  type CallingStage,
} from '@/domain/reception/calling-experience';
import type {
  Directory,
} from './useEffectiveConfiguration';
export /**
 * 呼び出し中の段階（dialing/waiting/preTimeoutNotice）から表示文言を導出する (#323)。
 *
 * ja のみテナント上書き（`guidanceCallingWaiting` / `guidanceCallingNotice`。#28 の
 * 案内文言設定と同じ運用）を尊重し、他 locale は i18n 辞書の既定文言を使う（`guidanceIdle` と
 * 同じ運用方針。avatar/guidance.ts の locale 内製文言とは別に、辞書（dictionary.ts）を
 * 真実源にする＝ #327 の全 locale 網羅検証の対象にする）。dialing 段階は既存の
 * `reception.callingBody` をそのまま使い、新規表示を増やさない（既存動作を変えない）。
 */
function callingStageMessage(
  stage: CallingStage,
  target: string,
  locale: Locale,
  textOverride: { waiting?: string; notice?: string },
): string {
  const tr = makeT(locale);
  if (stage === 'waiting') {
    return locale === DEFAULT_LOCALE && textOverride.waiting
      ? textOverride.waiting
      : tr('reception.callingStageWaiting');
  }
  if (stage === 'preTimeoutNotice') {
    return locale === DEFAULT_LOCALE && textOverride.notice
      ? textOverride.notice
      : tr('reception.callingStageNotice');
  }
  return tr('reception.callingBody', { target });
}

/**
 * 来訪者向けプライバシー通知 (issue #314)。要約は入力ステップで常時表示し、詳細
 * （利用目的・保存の有無・保持期間・問い合わせ先、presence カメラ注記）は折りたたみで読める。
 * タッチのみで開閉でき、大きな文字/コントラストの kiosk UI 基準 (#17) に沿う。
 */
export function PrivacyNotice({
  locale,
  overrideSummary,
  presenceCameraEnabled,
}: {
  locale: Locale;
  overrideSummary: string | undefined;
  presenceCameraEnabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = resolvePrivacyNoticeContent(locale, {
    overrideSummary,
    presenceCameraEnabled,
  });
  return (
    <div className="privacy-notice" data-testid="privacy-notice" lang={htmlLangFor(locale)}>
      <p className="privacy-notice__title">{content.title}</p>
      <p className="privacy-notice__summary" data-testid="privacy-notice-summary">
        {content.summary}
      </p>
      <button
        type="button"
        className="privacy-notice__toggle"
        data-testid="privacy-notice-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? content.detailsHideLabel : content.detailsShowLabel}
      </button>
      {expanded ? (
        <dl className="privacy-notice__details" data-testid="privacy-notice-details">
          <dt>{content.purposeLabel}</dt>
          <dd>{content.purposeText}</dd>
          <dt>{content.storageLabel}</dt>
          <dd>{content.storageText}</dd>
          <dt>{content.retentionLabel}</dt>
          <dd>{content.retentionText}</dd>
          <dt>{content.contactLabel}</dt>
          <dd>{content.contactText}</dd>
          {content.presenceCameraNote ? (
            <>
              <dt>{content.presenceCameraLabel}</dt>
              <dd data-testid="privacy-notice-presence-camera">{content.presenceCameraNote}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * 受付の各画面を状態から描き分ける (issue #422 increment 3)。
 *
 * かつて 29 個の位置引数を取っていた。`string | undefined` や `() => void` が並ぶため、
 * 引数を 1 つ入れ替えても型検査を通ってしまい、取り違えが実行時まで露見しない形だった。
 * 名前付きの 1 オブジェクトにして、順序の誤りを構造的に無くしている。
 */
type ReceptionScreenProps = {
  data: FlowData;
  dispatch: React.Dispatch<Action>;
  complete: () => void;
  onFallback: () => void;
  directory: Directory;
  guidanceIdle: string;
  vrmUrl: string | undefined;
  avatarFallbackUrl: string | undefined;
  sttEnabled: boolean;
  motionUrl: string | undefined;
  vonageCallId: string | null;
  staffResponse: StaffResponseResult | null;
  onStaffResponseFallback: () => void;
  /** 待機の入口カード（受付開始。用件の先取りを伴うことがある）。 */
  onEntry: (answer: TurnAnswerView) => void;
  /** 待機の引き渡し入口（QR 受付シェルへ切替。状態機械は進めない）。 */
  onHandoff: (handoff: TurnHandoffView) => void;
  locale: Locale;
  onLocaleChange: (next: Locale) => void;
  branding: BrandingSettings;
  /** 音声検索が使われたことを体験メトリクスへ通知する (issue #319)。 */
  onVoiceUse: () => void;
  /** 受付完了画面に提示する退館クレデンシャル (issue #342)。未発行なら null。 */
  checkoutCredential: CheckoutCredential | null;
  /** 来訪者向けプライバシー通知の要約文言の上書き (issue #28 / #314)。未設定は既定文言。 */
  privacyNoticeOverride: string | undefined;
  /** 来訪者検知カメラの有効状態 (issue #79)。有効時のみ通知にローカル処理・非保存の注記を足す。 */
  presenceCameraEnabled: boolean;
  /** 担当者検索の実行を体験メトリクスへ通知する（ヒット有無のみ。PII なし, issue #322）。 */
  onSearchQuery: (hasHit: boolean) => void;
  /** 検索 0 件時などから Chat-assisted ドロワーを開く合図を送る (issue #322)。 */
  onRequestChat: () => void;
  /**
   * 呼び出し中の経過段階 (issue #323)。UI 層のタイマー派生（state.ts/ui-contract.ts は不変）。
   * calling 以外の画面では参照しない。
   */
  callingStageState: { stage: CallingStage; elapsedMs: number };
  /** 呼び出し中の段階的ケアのテナント文言上書き (issue #28 / #323)。ja のみ適用。 */
  callingStageTextOverride: { waiting?: string; notice?: string };
  /**
   * ワンタップ満足度フィードバック (issue #320)。完了/未応答/失敗の終端画面のみが使う。
   * `enabled=false`（テナント設定でオフ）のときは呼び出し側で UI ごと出さない。
   */
  feedback: {
    enabled: boolean;
    onSubmit: (rating: SatisfactionRating, reasonCodes: FeedbackReasonCode[]) => void;
  };
  /** STT アダプタ注入 (#370)。未指定は既定 MockSttAdapter（無変更動作）。 */
  sttAdapterFactory: SttAdapterFactory | undefined;
  /** 取次段階 (#363)。Vonage 非同期通話ビューが段階表示する。旧形応答では空配列。 */
  callStages: CallStage[];
};

export function renderScreen({
  data,
  dispatch,
  complete,
  onFallback,
  directory,
  guidanceIdle,
  vrmUrl,
  avatarFallbackUrl,
  sttEnabled,
  motionUrl,
  vonageCallId,
  staffResponse,
  onStaffResponseFallback,
  onEntry,
  onHandoff,
  locale,
  onLocaleChange,
  branding,
  onVoiceUse,
  checkoutCredential,
  privacyNoticeOverride,
  presenceCameraEnabled,
  onSearchQuery,
  onRequestChat,
  callingStageState,
  callingStageTextOverride,
  feedback,
  sttAdapterFactory,
  callStages,
}: ReceptionScreenProps) {
  const tr = makeT(locale);
  switch (data.state) {
    case 'idle':
      return (
        <IdleView
          onEntry={onEntry}
          onHandoff={onHandoff}
          guidance={guidanceIdle}
          vrmUrl={vrmUrl}
          avatarFallbackUrl={avatarFallbackUrl}
          motionUrl={motionUrl}
          locale={locale}
          onLocaleChange={onLocaleChange}
          branding={branding}
        />
      );
    case 'selectingPurpose':
      return (
        <PurposeView
          onSelect={(purpose) => dispatch({ type: 'SELECT_PURPOSE', purpose })}
          locale={locale}
        />
      );
    case 'selectingTarget':
      return (
        <TargetView
          directory={directory}
          sttEnabled={sttEnabled}
          sttAdapterFactory={sttAdapterFactory}
          onSelect={(target) => dispatch({ type: 'SELECT_TARGET', target })}
          onVoiceUse={onVoiceUse}
          onSearchQuery={onSearchQuery}
          onRequestChat={onRequestChat}
          locale={locale}
        />
      );
    case 'inputVisitorInfo':
      return (
        <VisitorInfoView
          initial={data.visitor}
          onSubmit={(visitor) => dispatch({ type: 'SUBMIT_VISITOR_INFO', visitor })}
          locale={locale}
          privacyNoticeOverride={privacyNoticeOverride}
          presenceCameraEnabled={presenceCameraEnabled}
        />
      );
    case 'confirming':
      return (
        <ConfirmView
          data={data}
          onConfirm={() => dispatch({ type: 'CONFIRM' })}
          onBack={() => dispatch({ type: 'BACK' })}
          locale={locale}
        />
      );
    case 'calling':
      // Vonage（非同期）通話はビデオビューがライフサイクルを駆動する。Mock 同期通話は従来表示。
      // 担当者の応答アクションがあれば、その来訪者向けメッセージを上に重ねて表示する (issue #99)。
      return (
        <>
          <StaffResponseBanner
            // respondedAt で key を切り替え、新しい応答が届くたびに入場アニメを再生して
            // 「応答が届いた瞬間」を明確に伝える (issue #323 AC2)。
            key={staffResponse?.respondedAt ?? 'none'}
            response={staffResponse}
            onFallback={onStaffResponseFallback}
            locale={locale}
          />
          {vonageCallId ? (
            <KioskCallView
              receptionId={vonageCallId}
              onConnected={() => dispatch({ type: 'CALL_CONNECTED', sessionId: vonageCallId })}
              onTimeout={() => dispatch({ type: 'CALL_TIMEOUT', sessionId: vonageCallId })}
              onFallback={() => dispatch({ type: 'CALL_FAILED', sessionId: vonageCallId })}
              stages={callStages}
              locale={locale}
            />
          ) : (
            <CallingView
              target={data.target?.label ?? ''}
              locale={locale}
              stage={callingStageState.stage}
              textOverride={callingStageTextOverride}
            />
          )}
        </>
      );
    case 'connected':
      return (
        <>
          <StaffResponseBanner
            // respondedAt で key を切り替え、新しい応答が届くたびに入場アニメを再生して
            // 「応答が届いた瞬間」を明確に伝える (issue #323 AC2)。
            key={staffResponse?.respondedAt ?? 'none'}
            response={staffResponse}
            onFallback={onStaffResponseFallback}
            locale={locale}
          />
          <ConnectedView target={data.target?.label ?? ''} onComplete={complete} locale={locale} />
        </>
      );
    case 'timeout':
    case 'failed':
      return (
        <>
          <ResultView
            outcome={data.state}
            onFallback={onFallback}
            locale={locale}
            failureReason={data.failureReason}
          />
          {/* ワンタップ満足度フィードバック (#320)。テナント設定でオフなら UI ごと出さない。 */}
          {feedback.enabled ? <SatisfactionFeedback onSubmit={feedback.onSubmit} locale={locale} /> : null}
        </>
      );
    case 'fallback':
      return <FallbackView locale={locale} />;
    case 'cancelled':
      return <EndView testid="completed" tone="info" title={tr('reception.cancelled')} locale={locale} />;
    case 'completed':
      return (
        <>
          <EndView
            testid="completed"
            tone="success"
            title={tr('reception.completedTitle')}
            lead={tr('reception.thanksLead')}
            locale={locale}
          />
          {/* 退館クレデンシャル (#342)。発行できた場合のみ QR / 短コード / 有効期限を提示する。 */}
          {checkoutCredential ? (
            <CheckoutCredentialPanel credential={checkoutCredential} locale={locale} />
          ) : null}
          {/* ワンタップ満足度フィードバック (#320)。テナント設定でオフなら UI ごと出さない。 */}
          {feedback.enabled ? <SatisfactionFeedback onSubmit={feedback.onSubmit} locale={locale} /> : null}
        </>
      );
    default:
      return null;
  }
}

/* ---------- 各画面 (issue #11–#15) ---------- */

/**
 * 待機/初期画面 (issue #121 タッチファースト再設計)。
 *
 * 1 画面 1 主目的: 「何のご用件か」を大きなカードで選ぶ。主要 CTA（担当者を呼ぶ / QR で受付 /
 * 部署から選ぶ / 配送・納品 / その他）はクイックアクションとして `quickActionsFor('idle')` から
 * 描画する（ボタン集合の真実源は #120 の契約）。音声・チャットなしでもタッチだけで進める。
 *
 * 後方互換: 既存 E2E/テストが参照する `start-reception`（受付を開始する）と
 * `start-checkin`（QR で受付）の testid を、それぞれ「担当者を呼ぶ」「QR で受付」カードに
 * 付与し直して維持する。
 */
/** クイックアクション intent → 辞書キー（label/desc）。多言語表示に使う (#103)。 */

/**
 * 画面の主指示（見出し）。文言は会話ターン契約から解決する (#422 inc5-b)。
 *
 * 各画面が i18n キーを直に引くのをやめ、`messageKeyForState` 経由に一本化する。契約側の
 * 既定文言を直したのに画面が別のキーを引き続ける、という乖離を構造的に起こせなくする。
 * 主指示を持たない画面では `null` になるので、空の `<h1>` は生えない。
 */
function ScreenTitle({ state, locale }: { state: ReceptionState; locale: Locale }) {
  const title = screenTitleFor(state, locale);
  return title === null ? null : <h1 className="screen__title">{title}</h1>;
}

function IdleView({
  onEntry,
  onHandoff,
  guidance,
  vrmUrl,
  avatarFallbackUrl,
  motionUrl,
  locale,
  onLocaleChange,
  branding,
}: {
  onEntry: (answer: TurnAnswerView) => void;
  onHandoff: (handoff: TurnHandoffView) => void;
  guidance: string;
  vrmUrl?: string;
  avatarFallbackUrl?: string;
  motionUrl?: string;
  locale: Locale;
  onLocaleChange: (next: Locale) => void;
  branding: BrandingSettings;
}) {
  const tr = makeT(locale);
  // ja は管理設定で上書きできる案内文言（guidance）を使い、他言語は辞書の挨拶＋安心情報を出す (#103 / #324)。
  // リードは主指示（見出しの「ご用件をお選びください」）を重ねず、挨拶＋「タッチだけで受付できる」
  // 安心情報に限定して二重指示を避ける (#324)。文の区切りは locale に合わせる（CJK は「。」、他は「. 」）。
  // 'ja-simple' は日本語の一種なので 'ja' と同じ区切りにする (#321)。
  const sentenceSep = locale === 'ja' || locale === 'zh' || locale === 'ja-simple' ? '。' : '. ';
  const lead =
    locale === DEFAULT_LOCALE
      ? guidance
      : `${tr('welcome.title')}${sentenceSep}${tr('reception.idleReassure')}`;
  const hasBrand = hasBrandingContent(branding);
  return (
    <div
      className={`screen__body kiosk-idle${hasBrand ? ' kiosk-idle--branded' : ''}`}
      data-testid="kiosk-idle"
    >
      {/* テナントのブランド（ロゴ/社名）。待機画面を「その会社の受付」に見せる (#88)。 */}
      {hasBrand ? (
        <div className="kiosk-brand" data-testid="kiosk-brand">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="kiosk-brand__logo" src={branding.logoUrl} alt={branding.companyName ?? ''} />
          ) : null}
          {branding.companyName ? <span className="kiosk-brand__name">{branding.companyName}</span> : null}
        </div>
      ) : null}
      {/*
        #123 アバター状態同期。AvatarGuide が screenState から発話/字幕/モーションを導出し、
        idle では「AI受付です…」の字幕で AI 受付であることを初期体験で明示する。音声は KioskFlow 側の
        案内読み上げ（SPEAK_PHRASES）と二重化しないよう、ここでは字幕のみ（ttsSettings 未指定）。
        VRM/静止画が無くても字幕・フォールバックテキストで内容を保証する。pointer-events:none で操作を妨げない。
      */}
      <div className="kiosk-idle__avatar" data-slot="avatar">
        <AvatarGuide
          className="kiosk-avatar-guide"
          screenState="idle"
          locale={locale}
          vrmUrl={vrmUrl}
          fallbackImageUrl={avatarFallbackUrl}
          defaultMotionUrl={motionUrl}
        />
      </div>
      <header className="kiosk-idle__head">
        <ScreenTitle state="idle" locale={locale} />
        <p className="screen__lead" data-testid="idle-guidance" lang={htmlLangFor(locale)}>
          {lead}
        </p>
        {/* 言語切替 (#103)。読めない言語でも自言語ラベルで選べる。 */}
        <LanguageSwitcher
          locale={locale}
          onChange={onLocaleChange}
          label={tr('welcome.chooseLanguage')}
        />
      </header>
      {/*
        待機の入口カードは契約が決める (#422 inc5-b 増分 3b)。並び順・ラベル・用件の先取りは
        `turnAnswersFor`、QR 受付は `turnHandoffsFor`。**押したときに起こることが違う**
        （回答は状態機械のイベント、引き渡しは別シェルへの切替）ので取得元を分けている。
        アイコンと説明文はカードの見せ方なので画面が持つ。
      */}
      <div className="card-grid kiosk-quick-actions" data-testid="kiosk-quick-actions">
        {turnAnswersFor('idle', locale).map((answer) => (
          <button
            key={answer.id}
            type="button"
            className="card card--cta"
            data-testid={answer.testId}
            data-intent={answer.id}
            lang={htmlLangFor(locale)}
            onClick={() => onEntry(answer)}
          >
            <span className="card__icon" aria-hidden="true">
              {quickActionIcon(answer.id as QuickActionIntent)}
            </span>
            {answer.label}
            <span className="card__sub">{tr(`kiosk.action.${answer.id}.desc` as MessageKey)}</span>
          </button>
        ))}
        {turnHandoffsFor('idle', locale).map((handoff) => (
          <button
            key={handoff.id}
            type="button"
            className="card card--cta"
            data-testid={handoff.testId}
            data-intent={handoff.id}
            lang={htmlLangFor(locale)}
            onClick={() => onHandoff(handoff)}
          >
            <span className="card__icon" aria-hidden="true">
              {quickActionIcon(handoff.id as QuickActionIntent)}
            </span>
            {handoff.label}
            <span className="card__sub">{tr(`kiosk.action.${handoff.id}.desc` as MessageKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PurposeView({
  onSelect,
  locale,
}: {
  onSelect: (p: ReceptionPurposeId) => void;
  locale: Locale;
}) {
  // 「最初に戻る/キャンセル」は常設の逃げ道バー（EscapeHatchBar）に一本化したため、ここには置かない
  // （画面内フッターと逃げ道バーで「最初に戻る」が二重表示になる問題を解消, #121）。
  const tr = makeT(locale);
  // 待機の見出し（purposePrompt）と同一文言だと「担当者を呼ぶ」→ 目的選択で同じ質問が二重に見える
  // ため、ここは「種類の絞り込み」として purposeDetailPrompt を出す (#324-2)。
  // カード自体も待機カードと同じアイコン＋説明を持たせて視覚語彙を統一する (#324-3)。
  return (
    <>
      <ScreenTitle state="selectingPurpose" locale={locale} />
      <div className="screen__body">
        {/*
          用件カードの集合とラベルは契約が決める (#422 inc5-b 増分 3a)。アイコンと説明文は
          このカードの見せ方なので画面が持つ（`quick-actions.ts` の EscapeHatch と同じ分担）。
        */}
        <div className="card-grid">
          {turnAnswersFor('selectingPurpose', locale).map((answer) => (
            <button
              key={answer.id}
              type="button"
              className="card card--cta"
              data-testid={answer.testId}
              lang={htmlLangFor(locale)}
              onClick={() => onSelect(answer.id as ReceptionPurposeId)}
            >
              <span className="card__icon" aria-hidden="true">
                {purposeIcon(answer.id as ReceptionPurposeId)}
              </span>
              {answer.label}
              <span className="card__sub">
                {tr(`reception.purpose.${answer.id}.desc` as MessageKey)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function TargetView({
  directory,
  sttEnabled,
  sttAdapterFactory,
  onSelect,
  onVoiceUse,
  onSearchQuery,
  onRequestChat,
  locale,
}: {
  directory: Directory;
  sttEnabled: boolean;
  /** STT アダプタ注入 (#370)。未指定は既定 MockSttAdapter（無変更動作）。 */
  sttAdapterFactory?: SttAdapterFactory;
  onSelect: (t: Target) => void;
  /** 音声候補が採用されたことを体験メトリクスへ通知する (issue #319)。 */
  onVoiceUse?: () => void;
  /** 検索実行のヒット有無を体験メトリクスへ通知する（クエリ文字列は渡さない, issue #322）。 */
  onSearchQuery?: (hasHit: boolean) => void;
  /** 0 件時の「チャットで相談する」から Chat-assisted ドロワーを開く (issue #322)。 */
  onRequestChat?: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const [query, setQuery] = useState('');
  // 音声認識の候補。タップで検索欄に反映し、来訪者の確認後に選択する（即時呼び出ししない）(issue #5)。
  const [sttCandidates, setSttCandidates] = useState<string[]>([]);
  const [sttListening, setSttListening] = useState(false);
  const isSearching = query.trim() !== '';
  // 未入力時は従来どおり全件表示。入力時は tier 付きスコアリング検索（ローマ字/表記ゆれ/1 文字
  // typo に寛容, issue #322）を行い、exact/prefix/contains → fuzzy（もしかして）の順で並べる。
  const scored = useMemo(
    () => (isSearching ? searchStaffScored(directory.staff, query) : []),
    [directory.staff, query, isSearching],
  );
  const results = isSearching ? scored.map((m) => m.item) : directory.staff;
  const tierById = useMemo(() => new Map(scored.map((m) => [m.item.id, m.tier])), [scored]);
  const departments = directory.departments;
  const departmentSectionRef = useRef<HTMLDivElement>(null);
  const hasNoResults = isSearching && results.length === 0;

  // 検索実行のヒット有無を体験メトリクスへ記録する（クエリ文字列自体は保持しない, issue #322）。
  // 打鍵のたびに数えないよう軽くデバウンスする。
  useEffect(() => {
    if (!isSearching) return;
    const timer = setTimeout(() => {
      onSearchQuery?.(results.length > 0);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- results は query/directory から導出済み
  }, [query, isSearching]);

  const listen = useCallback(async () => {
    if (sttListening) return;
    setSttListening(true);
    try {
      // 候補生成元は在席担当者名。実 STT は注入ファクトリ (#370) で差し替える。既定は
      // MockSttAdapter（実ブラウザ音声認識は実機前提 #65）。中立 interface のみに依存する。
      const phrases = directory.staff
        .filter((s) => s.available)
        .map((s) => s.kana ?? s.displayName);
      const factory = sttAdapterFactory ?? defaultSttAdapterFactory;
      const candidates = await factory(phrases).listen();
      setSttCandidates(candidates);
    } finally {
      setSttListening(false);
    }
  }, [directory.staff, sttListening, sttAdapterFactory]);

  return (
    <>
      <ScreenTitle state="selectingTarget" locale={locale} />
      <div className="screen__body">
        <div className="field">
          <label className="field__label" htmlFor="staff-search" lang={htmlLangFor(locale)}>
            {tr('reception.searchStaff')}
          </label>
          <input
            id="staff-search"
            className="input"
            data-testid="staff-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr('reception.searchPlaceholder')}
            autoComplete="off"
          />
        </div>

        {sttEnabled ? (
          <div className="field" data-testid="stt-panel">
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="stt-listen"
              onClick={() => void listen()}
              disabled={sttListening}
            >
              {sttListening ? tr('reception.listening') : tr('reception.voiceSearch')}
            </button>
            {sttCandidates.length > 0 ? (
              <>
                <p className="card__sub" data-testid="stt-hint" lang={htmlLangFor(locale)}>
                  {tr('reception.voiceHint')}
                </p>
                <div className="card-grid" data-testid="stt-candidates">
                  {sttCandidates.map((c, i) => (
                    <button
                      key={`${c}-${i}`}
                      type="button"
                      className="card"
                      data-testid={`stt-candidate-${i}`}
                      // 候補は検索欄に反映するのみ。担当者選択・呼び出しは行わない (issue #5)。
                      // 音声候補の採用を主入力手段=音声として体験メトリクスに記録する (issue #319)。
                      onClick={() => {
                        onVoiceUse?.();
                        setQuery(c);
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className="card-grid">
            {results.map((s) =>
              s.available ? (
                <button
                  key={s.id}
                  type="button"
                  className="card"
                  data-testid={`staff-${s.id}`}
                  onClick={() => onSelect({ type: 'staff', id: s.id, label: s.displayName })}
                >
                  {tierById.get(s.id) === 'fuzzy' ? (
                    // あいまい一致（1 文字 typo・表記ゆれ由来）は「もしかして」と明示し、
                    // 完全一致/前方一致と混同させない (issue #322 AC2)。
                    <span className="card__badge" data-testid={`staff-${s.id}-maybe`} lang={htmlLangFor(locale)}>
                      {tr('reception.searchMaybeMatch')}
                    </span>
                  ) : null}
                  {s.displayName}
                  <span className="card__sub">{directory.departments.find((d) => d.id === s.departmentId)?.name}</span>
                </button>
              ) : (
                // 不在の担当者は呼び出せない。部署/代表窓口へ誘導する (issue #26)。
                <div
                  key={s.id}
                  className="card"
                  data-testid={`staff-${s.id}`}
                  data-unavailable="true"
                  aria-disabled="true"
                  style={{ opacity: 0.55, cursor: 'not-allowed' }}
                >
                  {s.displayName}
                  <span className="card__sub" data-testid={`staff-${s.id}-absent`} lang={htmlLangFor(locale)}>
                    {tr('reception.staffAbsent')}
                  </span>
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="notice notice--warning" data-testid="staff-empty" lang={htmlLangFor(locale)}>
            <p style={{ margin: 0 }}>{tr('reception.staffNotFound')}</p>
          </div>
        )}

        {hasNoResults ? (
          // 0 件で行き止まりにしない：部署一覧・チャット相談への次の一手を必ず提示する
          // (issue #322 AC3)。文言は i18n（dictionary.ts の privacy.* 隣接キー）。
          <div className="notice notice--warning" data-testid="search-no-results-guidance" lang={htmlLangFor(locale)}>
            <p style={{ margin: 0 }}>{tr('reception.searchNoResultsGuidance')}</p>
            <div className="card-grid" style={{ marginTop: 'var(--space-md)' }}>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="search-empty-department-cta"
                onClick={() =>
                  departmentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {tr('reception.byDepartment')}
              </button>
              {onRequestChat ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  data-testid="search-empty-chat-cta"
                  onClick={() => onRequestChat()}
                >
                  {tr('reception.searchNoResultsChatCta')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div ref={departmentSectionRef}>
          <h2 style={{ fontSize: 'var(--font-lg)', margin: 0 }} lang={htmlLangFor(locale)}>{tr('reception.byDepartment')}</h2>
          <div className="card-grid">
            {departments.map((d) => (
              <button
                key={d.id}
                type="button"
                className="card"
                data-testid={`dept-${d.id}`}
                onClick={() => onSelect({ type: 'department', id: d.id, label: d.name })}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/*
        後退（戻る/最初に戻る）は常設の逃げ道バー（EscapeHatchBar, sticky）へ一本化した (#325)。
        担当者一覧は長くなり得るが、バーは画面下端に常時可視なので戻る導線は失われない。
      */}
    </>
  );
}

function VisitorInfoView({
  initial,
  onSubmit,
  locale,
  privacyNoticeOverride,
  presenceCameraEnabled,
}: {
  initial?: VisitorInfo;
  onSubmit: (v: VisitorInfo) => void;
  locale: Locale;
  privacyNoticeOverride: string | undefined;
  presenceCameraEnabled: boolean;
}) {
  const tr = makeT(locale);
  const [name, setName] = useState(initial?.name ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const valid = name.trim().length > 0;

  return (
    <>
      <ScreenTitle state="inputVisitorInfo" locale={locale} />
      <div className="screen__body">
        {/* 用途・保存有無・保持期間・問い合わせ先を入力前に明示する (issue #314)。 */}
        <PrivacyNotice
          locale={locale}
          overrideSummary={privacyNoticeOverride}
          presenceCameraEnabled={presenceCameraEnabled}
        />
        <div className="field">
          <label className="field__label" htmlFor="visitor-name" lang={htmlLangFor(locale)}>
            {tr('reception.requiredLabel', { field: tr('reception.fieldName') })}
          </label>
          <input
            id="visitor-name"
            className="input"
            data-testid="visitor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="visitor-company" lang={htmlLangFor(locale)}>
            {tr('reception.optionalLabel', { field: tr('reception.fieldCompany') })}
          </label>
          <input
            id="visitor-company"
            className="input"
            data-testid="visitor-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="visitor-note" lang={htmlLangFor(locale)}>
            {tr('reception.optionalLabel', { field: tr('reception.fieldNote') })}
          </label>
          <input
            id="visitor-note"
            className="input"
            data-testid="visitor-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      {/* 後退（戻る/最初に戻る）は逃げ道バーへ一本化 (#325)。フッターは前進の主 CTA のみ。 */}
      <div className="screen__footer">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="to-confirm"
          disabled={!valid}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              company: company.trim() || undefined,
              note: note.trim() || undefined,
            })
          }
        >
          {tr('reception.proceedConfirm')}
        </button>
      </div>
    </>
  );
}

function ConfirmView({
  data,
  onConfirm,
  onBack,
  locale,
}: {
  data: FlowData;
  onConfirm: () => void;
  onBack: () => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const purposeLabel = data.purpose ? tr(`reception.purpose.${data.purpose}` as MessageKey) : '-';
  return (
    <>
      <ScreenTitle state="confirming" locale={locale} />
      <div className="screen__body">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-md)', fontSize: 'var(--font-lg)' }}>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldPurpose')}</dt>
          <dd style={{ margin: 0 }}>{purposeLabel}</dd>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldTarget')}</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-target">
            {data.target?.label}
          </dd>
          <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldName')}</dt>
          <dd style={{ margin: 0 }} data-testid="confirm-name">
            {data.visitor?.name}
          </dd>
          {data.visitor?.company ? (
            <>
              <dt className="card__sub" lang={htmlLangFor(locale)}>{tr('reception.fieldCompany')}</dt>
              <dd style={{ margin: 0 }}>{data.visitor.company}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="screen__footer">
        <button type="button" className="btn btn--ghost" data-testid="confirm-back" onClick={onBack}>
          {tr('reception.editInfo')}
        </button>
        {/*
          発信確定の CTA は契約が決める (#422 inc5-b 増分 2)。強調度（primary）だけが画面の
          裁量で、ラベル・testId・そもそも出すかは `turnAnswersFor` 経由。
        */}
        {turnAnswersFor('confirming', locale).map((answer) => (
          <button
            key={answer.id}
            type="button"
            className="btn btn--primary"
            data-testid={answer.testId}
            onClick={onConfirm}
          >
            {answer.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 担当者の応答アクションを来訪者向けに表示するバナー (issue #99)。
 * 応答がなければ何も描画しない（呼び出し中の通常表示を妨げない）。
 * 拒否・別チャネル誘導（offersFallback）のときは代替導線を併記する。
 *
 * (#323 AC2) 応答内容を主役として大きく表示する（`staff-response-banner--prominent`）。
 * 呼び出し側が `key={response.respondedAt}` を付けて呼ぶことで、新しい応答が届くたびに
 * 本コンポーネントが再マウントされ入場アニメ（`kiosk-rise`）が再生される＝「応答が届いた瞬間」を
 * 視覚的に明確化する。`kioskStatus === 'waiting'`（「5分お待ちください」）のときは、目安の
 * 再案内（reception.staffResponseWaitReguidance）を併記する。
 */
function StaffResponseBanner({
  response,
  onFallback,
  locale,
}: {
  response: StaffResponseResult | null;
  onFallback: () => void;
  locale: Locale;
}) {
  if (!response) return null;
  const noticeClass =
    response.severity === 'danger'
      ? 'notice notice--danger'
      : response.severity === 'warning'
        ? 'notice notice--warning'
        : response.severity === 'success'
          ? 'notice notice--success'
          : 'notice';
  return (
    <div
      className="staff-response-banner staff-response-banner--prominent"
      data-testid="staff-response-banner"
      data-status={response.kioskStatus}
      style={{ marginBottom: 'var(--space-md)' }}
    >
      <div className={`${noticeClass} staff-response-banner__message`} role="status" data-testid="staff-response-message">
        {response.visitorMessage}
      </div>
      {response.kioskStatus === 'waiting' ? (
        <p className="staff-response-banner__reguidance" data-testid="staff-response-reguidance" lang={htmlLangFor(locale)}>
          {makeT(locale)('reception.staffResponseWaitReguidance')}
        </p>
      ) : null}
      {response.offersFallback ? (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="staff-response-fallback"
          onClick={onFallback}
          style={{ marginTop: 'var(--space-sm)' }}
          lang={htmlLangFor(locale)}
        >
          {makeT(locale)('reception.toDesk')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 結果/待ち画面のトーンアイコン (#326 L1)。装飾のみ（ラベルはメッセージ側が持つ）で
 * aria-hidden にする。currentColor で `.result-panel--<tone>` の色を継承する。
 */
function ResultToneIcon({ tone }: { tone: ResultTone }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
  switch (tone) {
    case 'success':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.5 2.5 2.5L16 9.5" />
        </svg>
      );
    case 'danger':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...svgProps}>
          <path d="M12 3.5 21.5 20h-19L12 3.5z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      );
    case 'info':
    default:
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M12 11v5" />
        </svg>
      );
  }
}

/**
 * 結果/待ち画面の共通レイアウト (#326 L1)。
 *
 * 呼び出し中・結果（接続/タイムアウト/失敗/代替導線）・完了/キャンセルは、これまで
 * 「通知ピルが画面中央にぽつんと浮く」だけで死空間が大きかった。状態アイコン＋メッセージ＋
 * 次の一手（あれば）を 1 枚のパネル（.result-panel）へ凝集し、fold 内で完結させる。
 * トーンは `resultToneForState` が状態から一意に導出する（真実源はそちら）。
 * 後退（戻る/最初に戻る）は逃げ道バーへ一本化済み (#325) のため、ここでは前進系の
 * アクションのみを扱う。
 */
function ResultPanel({
  tone,
  testId,
  title,
  message,
  action,
  locale,
  panelDataAttrs,
  children,
}: {
  tone: ResultTone;
  /** パネル自体の testid。既存 e2e の可視性チェックはこのまま通る。 */
  testId: string;
  title?: string;
  message?: string;
  action?: {
    label: string;
    onClick: () => void;
    testId: string;
    variant?: 'primary' | 'secondary';
    /** 実行中に二度押しを防ぐため無効化する（例: 受付完了ボタンの busy ガード, #342）。 */
    disabled?: boolean;
  };
  locale: Locale;
  /** パネルの root div へ追加する data-* 属性（例: 呼び出し段階 #323）。 */
  panelDataAttrs?: Record<string, string>;
  /** アイコンとタイトルの間に差し込む追加要素（例: 経過インジケータ, #323）。 */
  children?: React.ReactNode;
}) {
  return (
    <div className="screen__body" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className={`result-panel result-panel--${tone}`} data-testid={testId} lang={htmlLangFor(locale)} {...panelDataAttrs}>
        <span className="result-panel__icon">
          <ResultToneIcon tone={tone} />
        </span>
        {children}
        {title ? <h1 className="result-panel__title">{title}</h1> : null}
        {message ? <p className="result-panel__message">{message}</p> : null}
        {action ? (
          <div className="result-panel__actions">
            <button
              type="button"
              className={`btn btn--${action.variant ?? 'primary'}`}
              data-testid={action.testId}
              onClick={action.onClick}
              disabled={action.disabled}
              lang={htmlLangFor(locale)}
            >
              {action.label}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 呼び出し中の待ち画面 (issue #323)。
 *
 * 「進んでいるのか固まっているのか分からない」を解消するため、常時アニメーションする
 * 経過インジケータ（`calling-pulse`。正確な秒数より「動いている」ことの伝達を優先）と、
 * 経過段階（dialing/waiting/preTimeoutNotice、UI 層のタイマー派生。state.ts は不変）に応じた
 * 文言の切り替えを行う。`stage` は KioskFlow の `useCallingStage` が算出する。
 */
function CallingView({
  target,
  locale,
  stage,
  textOverride,
}: {
  target: string;
  locale: Locale;
  /** 呼び出し中の経過段階 (#323)。UI 層のタイマー派生。 */
  stage: CallingStage;
  /** テナントの案内文言上書き（ja のみ, #28）。未設定は i18n 既定文言。 */
  textOverride: { waiting?: string; notice?: string };
}) {
  const tr = makeT(locale);
  return (
    <ResultPanel
      tone={stage === 'preTimeoutNotice' ? 'warning' : resultToneForState('calling')}
      testId="calling"
      title={tr('reception.callingTitle')}
      message={callingStageMessage(stage, target, locale, textOverride)}
      locale={locale}
      panelDataAttrs={{ 'data-calling-stage': stage }}
    >
      {/* 常時動く経過インジケータ。「動いている」ことの伝達を優先し、正確な秒数は示さない。
          prefers-reduced-motion は globals.css の全体ルールで自動的に抑制される。 */}
      <span className="calling-pulse" data-testid="calling-pulse" aria-hidden="true">
        <span className="calling-pulse__dot" />
        <span className="calling-pulse__dot" />
        <span className="calling-pulse__dot" />
      </span>
    </ResultPanel>
  );
}

function ConnectedView({
  target,
  onComplete,
  locale,
}: {
  target: string;
  onComplete: () => void | Promise<void>;
  locale: Locale;
}) {
  const tr = makeT(locale);
  // 二度押しガード: 完了は在館記録の起票 API を伴い、サーバの冪等チェックは check-then-act で
  // 非原子的（#342 レビュー指摘）。実運用の二重タップ由来の重複起票を単一 in-flight に絞るため、
  // 実行中はボタンを無効化して onComplete を一度しか発火させない（KioskAuthorize.busy と同型）。
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onComplete();
    } finally {
      setBusy(false);
    }
  };
  // connected は「担当者がまいります／操作は不要です」を message で明示し、終了操作は任意にする (#324-5)。
  // 主 CTA（primary）で終了を促すと「押さないと進まない」と誤解させるため、secondary の任意アクションにする。
  // 「操作不要」の案内と挙動を一致させるため、connected は無操作タイムアウトで待機へ自動復帰する
  // （INACTIVITY_RESET_STATES に connected を追加, #324）。明示的に今すぐ終えたい来訪者のため操作は残す。
  return (
    <ResultPanel
      tone={resultToneForState('connected')}
      testId="result-connected"
      message={tr('reception.connectedBody', { target })}
      action={
        // 終了操作の CTA も契約が決める (#422 inc5-b 増分 2)。強調度（secondary＝任意操作で
        // あることを示す）と二度押しガードだけが画面の裁量。
        turnAnswersFor('connected', locale).map((answer) => ({
          label: answer.label,
          onClick: () => void finish(),
          testId: answer.testId,
          variant: 'secondary' as const,
          disabled: busy,
        }))[0]
      }
      locale={locale}
    />
  );
}

function ResultView({
  outcome,
  onFallback,
  locale,
  failureReason,
}: {
  outcome: 'timeout' | 'failed';
  onFallback: () => void;
  locale: Locale;
  /** 呼び出し失敗の理由 (#422)。通信断とサーバ側の失敗を同じ文言で伝えない。 */
  failureReason?: CallFailureReason;
}) {
  const tr = makeT(locale);
  const message = tr(
    outcome === 'timeout' ? 'reception.timeoutBody' : failedMessageKeyFor(failureReason),
  );
  // 代替導線を出すかの判断は契約が持つ (#422 inc5-b 増分 2)。通信断では「代表窓口にお繋ぎ
  // します」という約束を果たせないため出さない、という判断はかつてここと契約の両方に在り、
  // #486 で逃げ道について潰したのと同じ二重実装だった。いまは `callFailureReason` を契約へ
  // 渡すだけで、ここは返ってきた回答を描くだけにする。
  const [answer] = turnAnswersFor(outcome, locale, { callFailureReason: failureReason });
  // 後退（最初に戻る）は逃げ道バーへ一本化 (#325)。コンテンツ側は前進の主 CTA（代替の連絡先へ＝
  // useFallback）のみ。以前あった result-reset（最初に戻る）はバーの escape-reset と重複するため撤去。
  return (
    <ResultPanel
      tone={resultToneForState(outcome)}
      testId={`result-${outcome}`}
      message={message}
      action={
        answer
          ? { label: answer.label, onClick: onFallback, testId: answer.testId, variant: 'secondary' as const }
          : undefined
      }
      locale={locale}
    />
  );
}

function FallbackView({ locale }: { locale: Locale }) {
  const tr = makeT(locale);
  // 後退（最初に戻る）は逃げ道バー（escape-reset）へ一本化 (#325)。以前あった fallback-reset は
  // バーと重複するため撤去し、コンテンツは代替案内メッセージのみにする。
  return (
    <ResultPanel
      tone={resultToneForState('fallback')}
      testId="fallback"
      message={tr('reception.fallbackBody')}
      locale={locale}
    />
  );
}

/** ワンタップ満足度評価の表示順・絵文字・testid・aria-label キー (issue #320)。 */
const SATISFACTION_RATINGS: readonly { rating: SatisfactionRating; icon: string; labelKey: MessageKey }[] = [
  { rating: 'happy', icon: '😊', labelKey: 'reception.feedback.happy' },
  { rating: 'neutral', icon: '😐', labelKey: 'reception.feedback.neutral' },
  { rating: 'unhappy', icon: '😞', labelKey: 'reception.feedback.unhappy' },
];

/** 満足度評価に添える定型理由チップの表示順・testid・辞書キー (issue #320)。自由記述は無い。 */
const FEEDBACK_REASON_CHIPS: readonly { code: FeedbackReasonCode; labelKey: MessageKey }[] = [
  { code: 'waitTooLong', labelKey: 'reception.feedback.reason.waitTooLong' },
  { code: 'hardToOperate', labelKey: 'reception.feedback.reason.hardToOperate' },
  { code: 'staffUnavailable', labelKey: 'reception.feedback.reason.staffUnavailable' },
  { code: 'other', labelKey: 'reception.feedback.reason.other' },
];

/**
 * 終端画面（完了/未応答/失敗）のワンタップ満足度フィードバック (issue #320)。
 *
 * AC「1 タップで評価でき、直後に通常の自動復帰が動く」: 絵文字ボタンを 1 回タップした時点で
 * 評価を確定・送信する（送信は fire-and-forget。以降の待機/確認ステップは無い）。理由チップは
 * 評価後に追加で選べる任意項目で、選択のたびに（評価値 + そこまでの選択）を再送して上書きする。
 * 自由記述欄は存在しない（コード化された列挙のみ、#105 PII 最小化）。
 *
 * 評価しないまま放置しても何も送信されない（AC「評価せず放置しても体験が変わらない」）。
 * 親（KioskFlow）は画面遷移ごとに `key={data.state}` で本コンポーネントを再マウントするため、
 * 内部状態（rating/reasons）は終端画面に入るたびに自然にリセットされる。
 */
function SatisfactionFeedback({
  onSubmit,
  locale,
}: {
  onSubmit: (rating: SatisfactionRating, reasonCodes: FeedbackReasonCode[]) => void;
  locale: Locale;
}) {
  const tr = makeT(locale);
  const [rating, setRating] = useState<SatisfactionRating | null>(null);
  const [reasons, setReasons] = useState<FeedbackReasonCode[]>([]);

  const pickRating = (next: SatisfactionRating) => {
    if (rating !== null) return; // 評価は 1 タップで確定（連打で上書きしない）
    setRating(next);
    onSubmit(next, []);
  };

  const toggleReason = (code: FeedbackReasonCode) => {
    if (rating === null) return;
    const next = reasons.includes(code) ? reasons.filter((c) => c !== code) : [...reasons, code];
    setReasons(next);
    onSubmit(rating, next);
  };

  return (
    <div className="satisfaction-feedback" data-testid="satisfaction-feedback" lang={htmlLangFor(locale)}>
      {rating === null ? (
        <>
          <p className="satisfaction-feedback__prompt">{tr('reception.feedback.prompt')}</p>
          <div
            className="satisfaction-feedback__ratings"
            role="group"
            aria-label={tr('reception.feedback.prompt')}
          >
            {SATISFACTION_RATINGS.map(({ rating: r, icon, labelKey }) => (
              <button
                key={r}
                type="button"
                className="satisfaction-feedback__rating-btn"
                data-testid={`satisfaction-${r}`}
                aria-label={tr(labelKey)}
                onClick={() => pickRating(r)}
              >
                <span aria-hidden="true">{icon}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="satisfaction-feedback__prompt" data-testid="satisfaction-feedback-thanks">
            {tr('reception.feedback.thanks')}
          </p>
          <p className="satisfaction-feedback__prompt">{tr('reception.feedback.reasonPrompt')}</p>
          <div
            className="satisfaction-feedback__reasons"
            role="group"
            aria-label={tr('reception.feedback.reasonPrompt')}
          >
            {FEEDBACK_REASON_CHIPS.map(({ code, labelKey }) => (
              <button
                key={code}
                type="button"
                className="satisfaction-feedback__reason-chip"
                data-testid={`satisfaction-reason-${code}`}
                aria-pressed={reasons.includes(code)}
                onClick={() => toggleReason(code)}
              >
                {tr(labelKey)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 無操作リセット直前のカウントダウン警告 (issue #125 UX, "don't surprise-expire")。
 * 突然のリセットで来訪者を驚かせず、プライバシーのために戻ることを予告し、続行手段を与える。
 */
export function InactivityWarning({
  seconds,
  locale,
  onContinue,
}: {
  seconds: number;
  locale: Locale;
  onContinue: () => void;
}) {
  const tr = makeT(locale);
  return (
    <div
      className="inactivity-overlay"
      data-testid="inactivity-warning"
      role="alertdialog"
      aria-live="assertive"
      aria-label={tr('reception.inactivityTitle')}
      lang={htmlLangFor(locale)}
    >
      <div className="inactivity-overlay__panel">
        <h2 className="inactivity-overlay__title">{tr('reception.inactivityTitle')}</h2>
        <p className="inactivity-overlay__body">{tr('reception.inactivityBody')}</p>
        <p className="inactivity-overlay__count" data-testid="inactivity-countdown">
          {tr('reception.inactivityCountdown', { seconds })}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="inactivity-continue"
          onClick={onContinue}
        >
          {tr('reception.inactivityContinue')}
        </button>
      </div>
    </div>
  );
}

function EndView({
  testid,
  tone,
  title,
  lead,
  locale,
}: {
  testid: string;
  tone: ResultTone;
  title: string;
  lead?: string;
  locale: Locale;
}) {
  return <ResultPanel tone={tone} testId={testid} title={title} message={lead} locale={locale} />;
}

/**
 * 退館クレデンシャルの有効期限（ISO）を locale の時刻表記へ整形する (issue #342)。
 * 不正日付は空文字（表示を壊さない）。
 */
function formatExpiryTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * 受付完了画面の退館クレデンシャル提示 (issue #342)。
 *
 * 退館 QR（token を参照する URL のみを符号化。PII 非包含）・短い退館コード・有効期限・一行案内を出す。
 * 表示のみで、来訪者を待たせず（発行できた場合に後追い表示）、失敗時はそもそも描画しない
 * （呼び出し側が credential=null を渡す）。氏名・会社名は同居させない。token/code はログに出さない。
 * 色リテラルは使わずデザイントークン（--space-* 等）とデザインシステムのクラスに揃える。
 */
function CheckoutCredentialPanel({
  credential,
  locale,
}: {
  credential: CheckoutCredential;
  locale: Locale;
}) {
  const tr = makeT(locale);
  // origin はブラウザ由来（SSR 時は空。完了画面はクライアントで描画される）。
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const checkoutUrl = buildCheckoutUrl(origin, credential.token);
  const qrAlt = tr('checkout.credential.qrAlt');
  // QR 生成は render 中に走る。完了画面には error boundary が無いため、throw すると退館コード/
  // 案内まで巻き添えでクラッシュする。安全版で失敗時は null にし、QR を省いてコード/案内は残す。
  const qrSrc = safeCheckoutQrDataUrl(checkoutUrl, qrAlt);
  const expiry = formatExpiryTime(credential.expiresAt, locale);
  return (
    <section
      className="checkout-credential"
      data-testid="checkout-credential"
      lang={htmlLangFor(locale)}
      style={{
        marginTop: 'var(--space-lg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        textAlign: 'center',
      }}
    >
      <h2 className="screen__title" style={{ fontSize: 'var(--font-lg)' }}>
        {tr('checkout.credential.title')}
      </h2>
      <p className="screen__lead">{tr('checkout.credential.instruction')}</p>
      {qrSrc ? (
        <img
          src={qrSrc}
          alt={qrAlt}
          data-testid="checkout-credential-qr"
          width={200}
          height={200}
          style={{ width: 200, height: 200, maxWidth: '60vw' }}
        />
      ) : null}
      <p className="checkout-credential__code" style={{ fontSize: 'var(--font-lg)' }}>
        {tr('checkout.credential.codeLabel')}:{' '}
        <strong data-testid="checkout-credential-code" style={{ letterSpacing: '0.15em' }}>
          {credential.code}
        </strong>
      </p>
      {expiry ? (
        <p className="screen__lead" data-testid="checkout-credential-expiry">
          {tr('checkout.credential.expiresAt', { time: expiry })}
        </p>
      ) : null}
    </section>
  );
}
