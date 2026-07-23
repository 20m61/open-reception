'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nextIndex } from '@/domain/signage/rotation';
import { DEFAULT_SITE_ID, DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';
import type { KioskSignage, KioskSignageItem } from '@/lib/signage/kiosk-signage';
import { hasBrandingContent, type BrandingSettings } from '@/domain/branding/types';
import { makeT, DEFAULT_LOCALE, htmlLangFor, normalizeLocale, type Locale } from '@/lib/i18n';
import { SignageItemView } from './SignageItemView';
import { SignageClock } from './SignageClock';

/**
 * 待機中サイネージの表示 (issue #101, increment 1)。スタンドアロン待機画面。
 *
 * 端末向け API（/api/kiosk/signage）から再生可能な項目を取得し、各項目の表示秒数で
 * 巡回する（巡回判定は純関数 nextIndex に委譲）。タップ/クリック/キー操作で /kiosk へ
 * 遷移＝受付復帰する（issue #101: タップで受付開始へ）。
 *
 * presence 連携（来訪検知での自動復帰）は import 参照に留め、実配線は次増分:
 *   - 検知状態は src/domain/presence/state.ts（PresenceState: IDLE→…→ACTIVE）が持つ。
 *   - ACTIVE 遷移（来訪検知）を受けて本コンポーネントが /kiosk へ遷移する配線を次増分で追加する。
 *   - ここでは明示操作（タップ/キー）による復帰のみを実装する。
 *
 * 受付開始の導線は常に大きく表示する（issue #101 UX 方針）。緊急停止/通信断の優先表示は
 * 次増分（kiosk/config の active と統合）。本増分は待機中の純粋なサイネージ表示に限る。
 */
export function SignageDisplay({
  tenantId = DEFAULT_TENANT_ID,
  siteId = DEFAULT_SITE_ID,
  onStart,
  locale,
  paused = false,
  bottomInsetPx = 0,
}: {
  tenantId?: string;
  siteId?: string;
  /**
   * 画面下端に確保する追い出し量 (px)。KioskFlow 埋め込みでは絶対配置のフッター
   * （QR受付/退館/来訪検知）が重なるため、その実測高さを渡して受付開始 CTA と
   * 衝突しないようにする (issue #362 実ブラウザ検証)。スタンドアロンでは 0。
   */
  bottomInsetPx?: number;
  /**
   * 受付復帰の振る舞いを差し替えるフック (kiosk-integration inc1)。
   * - 未指定（スタンドアロン /kiosk/signage）: 既定どおり /kiosk へ遷移する（非破壊）。
   * - 指定（KioskFlow へ埋め込み）: 画面遷移せず受付状態機械の START を呼ぶ。
   */
  onStart?: () => void;
  /**
   * 表示言語 (#327 2nd increment)。
   * - KioskFlow へ埋め込む場合: 選択中 locale を明示的に渡す（React state で一意に決まる）。
   * - 未指定（スタンドアロン /kiosk/signage）: CheckoutLink と同じ `?locale=` クエリ規約を
   *   マウント後に読み取り、既定 locale へフォールバックする。
   */
  locale?: Locale;
  /**
   * ATTRACT オーバーレイ表示中の一時停止 (issue #362)。true の間は項目巡回を止め（表示中の
   * 項目のまま固定＝「サイネージ停止」）、タップ/キー操作による受付復帰も無効化する。
   * ATTRACT オーバーレイが画面を覆い明示 CTA だけを唯一の受付導線にするため、下に隠れた
   * この待機画面自体が同時に反応してしまうと「タップ以外（オーバーレイ外縁のはみ出し等）で
   * 受付が始まる」抜け道になる。既定 false（スタンドアロン /kiosk/signage は常に非対象）。
   */
  paused?: boolean;
}) {
  const router = useRouter();
  const [signage, setSignage] = useState<KioskSignage | null>(null);
  const [index, setIndex] = useState(0);
  // テナントのブランド設定 (issue #88)。アセット未設定フォールバック (#326 L1) で
  // 「会社の顔」を出すために使う。取得失敗時は汎用フォールバック（時計＋挨拶のみ）にする。
  const [branding, setBranding] = useState<BrandingSettings>({});
  // スタンドアロン利用時の表示言語 (#327)。`locale` prop が明示されていればそちらを優先する。
  const [queryLocale, setQueryLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    if (locale) return;
    setQueryLocale(normalizeLocale(new URLSearchParams(window.location.search).get('locale')));
  }, [locale]);
  const resolvedLocale = locale ?? queryLocale;
  const tr = makeT(resolvedLocale);

  // 受付復帰: 明示操作で受付へ。連打を吸収するため一度だけ実行する。
  // paused 中（ATTRACT オーバーレイ表示中）はこの待機画面自体の復帰導線を無効化する
  // （受付復帰は常にオーバーレイの明示 CTA からのみ, issue #362）。
  const returned = useRef(false);
  const returnToReception = useCallback(() => {
    if (paused || returned.current) return;
    returned.current = true;
    if (onStart) onStart();
    else router.push('/kiosk');
  }, [router, onStart, paused]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/kiosk/signage?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSignage(data as KioskSignage);
      })
      .catch(() => {
        /* 読み込み失敗時はフォールバック表示にする（下の hasContent 判定で拾う）。 */
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, siteId]);

  // ブランド設定を取得する (#88 / #326)。失敗時は汎用フォールバックのまま。
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/kiosk/branding')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setBranding(data as BrandingSettings);
      })
      .catch(() => {
        /* 取得失敗時は汎用フォールバック */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = signage?.items ?? [];
  const current: KioskSignageItem | undefined = items[Math.min(index, Math.max(items.length - 1, 0))];

  // 現在項目の表示秒数で次へ進める。paused 中は巡回を止め、表示中の項目のまま固定する
  // （ATTRACT オーバーレイの「サイネージ停止」, issue #362）。
  useEffect(() => {
    if (items.length <= 1 || !current || paused) return;
    const ms = Math.max(current.durationSeconds, 3) * 1000;
    const id = setTimeout(() => setIndex((i) => nextIndex(i, items.length)), ms);
    return () => clearTimeout(id);
  }, [items.length, current, paused]);

  // キーボードでも受付復帰できるようにする（iPad の外付けキーボード等）。
  useEffect(() => {
    const onKey = () => returnToReception();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [returnToReception]);

  return (
    // 全面タップで受付復帰する待機画面。以前は外側 div 自身に role="button" tabIndex={0} を
    // 付けていたが、内側に focusable な signage-start ボタンを内包するため axe の
    // nested-interactive（no-focusable-content）に該当していた（#361 VRT/axe で serious 検出）。
    // 解消のため外側は「非対話のコンテナ + ポインタ操作の便宜ハンドラ」に留め、キーボード/
    // 支援技術向けの明示的な受付導線は下部の signage-start ボタン（フォーカス可能）と window の
    // keydown リスナに一本化する。ポインタ操作（タップ/クリック）は非対話要素上でも発火するため
    // iPad 受付端末の「どこをタップしても開始」は維持される。
    <div
      data-testid="signage-display"
      onClick={returnToReception}
      onTouchStart={returnToReception}
      style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        padding: 32,
        paddingBottom: 32 + bottomInsetPx,
        cursor: 'pointer',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
      }}
    >
      <div
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {current ? (
          <SignageItemView item={toSignageItem(current)} />
        ) : (
          <SignageFallback branding={branding} locale={resolvedLocale} />
        )}
      </div>

      {/* 受付開始の導線は常に大きく表示する（クリック/タップで /kiosk へ）。 */}
      <button
        type="button"
        data-testid="signage-start"
        lang={htmlLangFor(resolvedLocale)}
        onClick={(e) => {
          e.stopPropagation();
          returnToReception();
        }}
        style={{
          fontSize: 'clamp(20px, 3.5vw, 40px)',
          fontWeight: 800,
          padding: '20px 48px',
          borderRadius: 999,
          border: 'none',
          background: 'var(--color-accent)',
          color: 'var(--color-bg)',
          cursor: 'pointer',
        }}
      >
        {tr('kiosk.signage.tapToStart')}
      </button>
    </div>
  );
}

/**
 * サイネージのアセット未設定フォールバック (issue #326 L1)。
 *
 * 再生可能な項目が 0（未設定・無効・取得失敗）のとき、待機中サイネージが黒画面のまま
 * 何も出さない状態を解消する。ブランド設定（ロゴ/社名）があれば「会社の顔」を出し、
 * 無くても時計＋既定の挨拶で「動いている」ことを示す既定フォールバックにする。
 * 文言は kiosk 待機画面（IdleView）と同じ辞書キー（welcome.*）を再利用し、新規キーは
 * 追加しない。表示言語は呼び出し元が解決した locale に従う (#327 2nd increment。以前は
 * DEFAULT_LOCALE 固定で、選択中言語に関わらず常に日本語が出ていた翻訳漏れ)。
 */
function SignageFallback({ branding, locale }: { branding: BrandingSettings; locale: Locale }) {
  const tr = makeT(locale);
  const showBrand = hasBrandingContent(branding);
  return (
    <div
      data-testid="signage-fallback"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        textAlign: 'center',
      }}
    >
      {showBrand ? (
        <div
          data-testid="signage-fallback-brand"
          style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', justifyContent: 'center' }}
        >
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt={branding.companyName ?? ''}
              style={{ height: 96, maxWidth: 360, objectFit: 'contain' }}
            />
          ) : null}
          {branding.companyName ? (
            <span style={{ fontSize: 'clamp(28px, 4vw, 56px)', fontWeight: 800 }}>{branding.companyName}</span>
          ) : null}
        </div>
      ) : null}
      <SignageClock />
      {/*
        上部ヒントは挨拶（welcome.title）のみにする (#324-4)。受付開始の「タップして開始」導線は
        下部の大きな CTA ボタンに一本化し、上下で同一文言（タップして開始）を重複させない。
      */}
      <p
        lang={htmlLangFor(locale)}
        style={{ fontSize: 'clamp(20px, 3vw, 40px)', opacity: 0.85, margin: 0, maxWidth: '70%' }}
      >
        {tr('welcome.title')}
      </p>
    </div>
  );
}

/** KioskSignageItem を表示コンポーネント用の SignageItem 形へ写す（id は表示に不要なダミー）。 */
function toSignageItem(item: KioskSignageItem) {
  return {
    id: 'kiosk-signage-item' as never,
    type: item.type,
    enabled: true,
    title: item.title,
    message: item.message,
    imageUrl: item.imageUrl,
    imageAlt: item.imageAlt,
    slideUrls: item.slideUrls,
    durationSeconds: item.durationSeconds,
  };
}
