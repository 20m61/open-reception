/**
 * 音声対話の字幕・復唱確認・タッチ縮退案内レイヤ (issue #361 音声復唱 UI / #364 kiosk 配線)。
 *
 * `ConversationTurnView` シェルの流儀（`src/domain/reception/ui-contract.ts`）に沿う表示専用
 * コンポーネント: 状態（`VoiceKioskState`）を描画するだけで、遷移判断は持たない（判断は
 * `voiceKioskReducer` / `VoiceKioskStore` に一元化）。既存の 35%/65% レール（アバター/操作）を
 * 壊さないよう、画面下部に重ねる非破壊のオーバーレイとして描画する（`data-voice-mode` を公開し、
 * アバター口パク結線などが購読できる結線点にする）。
 *
 * アクセシビリティ/PII:
 *  - 字幕は `aria-live="polite"` で読み上げる（視覚に頼らない案内）。`lang` を locale から付与。
 *  - タッチはあらゆる局面で有効（音声が失敗してもタッチだけで完走できる不変条件）。
 *  - `readbackName` は組織が管理する担当者/部門の表示名で、一時表示のみ。ログ/eval へは出力しない。
 */
'use client';

import { htmlLangFor, makeT, type Locale } from '@/lib/i18n';
import {
  captionKeyFor,
  voiceListeningStage,
  type VoiceKioskState,
} from '@/domain/voice-session/kiosk-view';
import { persistentRegionProps } from './persistent-regions';

export type VoiceReadbackConfirmProps = {
  state: VoiceKioskState;
  locale: Locale;
  /** 復唱「はい」（タッチ）。音声「はい」は Store 側で同じ入口に集約される。 */
  onYes: () => void;
  /** 復唱「いいえ」（タッチ）。 */
  onNo: () => void;
};

/**
 * 音声対話 UI レイヤ。`inactive` のときは何も描画しない（音声モード未注入時の完全な無変更動作）。
 */
export function VoiceReadbackConfirm({ state, locale, onYes, onNo }: VoiceReadbackConfirmProps) {
  if (state.mode === 'inactive') return null;

  const tr = makeT(locale);
  const isReadback = state.mode === 'readback';
  const isFallback = state.mode === 'fallback';
  // 聞き取り中インジケータの 2 段階（idle=話しかけ待ち / speech=発話検知中）。listening 以外は null。
  const listeningStage = voiceListeningStage(state);
  // interim（確定前）逐次字幕。listening で非空のときのみ主字幕として描画する（PII は表示のみ）。
  const interim = listeningStage === 'speech' ? (state.interimText ?? '') : '';
  // fallback は専用の縮退案内で描くため字幕としては重複させない。listening で interim を主字幕に
  // するときは静的プロンプト（お話しください）を重複させない。
  const captionKey = isFallback || interim !== '' ? null : captionKeyFor(state);
  const caption = captionKey ? tr(captionKey, { name: state.readbackName ?? '' }) : null;

  return (
    <div
      className="voice-layer"
      {...persistentRegionProps('voice-layer')}
      data-voice-mode={state.mode}
      lang={htmlLangFor(locale)}
      style={{
        /*
         * 🔴 **viewport 基準に固定する** (#788)。`absolute` だと positioned な祖先が無く
         * 初期包含ブロック（文書原点）基準になるため、担当者リストをスクロールすると
         * 復唱がカードの上へ流れて上端付近まで昇ってしまう。逃げ道バー（sticky）・
         * チャット FAB（fixed）と同じ基準系へ揃える。
         */
        position: 'fixed',
        left: 0,
        right: 0,
        /*
         * 🔴 **逃げ道バー（`.kiosk-escape-bar`、sticky・z-index 30）の上へ逃がす** (#788)。
         * `bottom: 0` だと「戻る」と物理的に重なり、どちらかが必ず押せなくなる。
         * 持ち上げ量は `KioskFlow` が**バーの実位置から実測**して渡す（固定値にすると、
         * 内容がスクロールしない画面でバーが下端に付かず食い込む。実測で 4K が壊れた）。
         */
        bottom: 'var(--kiosk-voice-safe-bottom, 16px)',
        /*
         * 🔴 **操作カードより前面** (#788)。この層は DOM 上で受付画面より**前**に置かれており、
         * `.screen-anim` が animation で stacking context を作るため、z-index が無いと
         * 担当者カードが復唱の「はい／いいえ」を覆って**押せなくなる**（実測: Playwright が
         * `staff-*` に pointer events を奪われた）。逃げ道バー（30）より下に留めて、
         * 「戻る」を隠さない。
         */
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-sm, 8px)',
        padding: 'var(--space-md, 16px)',
        // 字幕・案内は操作を妨げない。ボタンだけ個別に pointer-events を戻す。
        pointerEvents: 'none',
      }}
    >
      {listeningStage ? (
        <div
          className={`voice-layer__indicator voice-layer__indicator--${listeningStage}`}
          data-testid="voice-listening-indicator"
          data-stage={listeningStage}
          aria-hidden="true"
        >
          {/* CSS のみのパルス/波形風。prefers-reduced-motion では globals.css が静的表現へ落とす。 */}
          <span className="voice-layer__wave" />
          <span className="voice-layer__wave" />
          <span className="voice-layer__wave" />
          <span className="voice-layer__wave" />
          <span className="voice-layer__wave" />
        </div>
      ) : null}

      {caption ? (
        <p
          className="voice-layer__caption"
          data-testid="voice-caption"
          aria-live="polite"
          style={{ margin: 0, textAlign: 'center', fontWeight: 600 }}
        >
          {caption}
        </p>
      ) : null}

      {interim !== '' ? (
        <p
          className="voice-layer__interim"
          data-testid="voice-interim"
          aria-live="polite"
          style={{ margin: 0, textAlign: 'center', fontWeight: 600 }}
        >
          {interim}
        </p>
      ) : null}

      {isReadback ? (
        <div
          className="voice-layer__readback"
          data-testid="voice-readback"
          role="group"
          style={{ display: 'flex', gap: 'var(--space-sm, 8px)', pointerEvents: 'auto' }}
        >
          <button
            type="button"
            className="btn btn--primary"
            data-testid="voice-confirm-yes"
            onClick={onYes}
          >
            {tr('voice.readback.yes')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="voice-confirm-no"
            onClick={onNo}
          >
            {tr('voice.readback.no')}
          </button>
        </div>
      ) : null}

      {isFallback ? (
        <p
          className="notice notice--warning voice-layer__fallback"
          data-testid="voice-fallback-notice"
          role="status"
          style={{ margin: 0, textAlign: 'center', pointerEvents: 'auto' }}
        >
          {tr('voice.fallback.touchNotice')}
        </p>
      ) : null}
    </div>
  );
}
