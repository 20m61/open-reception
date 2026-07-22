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
import { captionKeyFor, type VoiceKioskState } from '@/domain/voice-session/kiosk-view';

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
  // fallback は専用の縮退案内で描くため、字幕としては重複させない。
  const captionKey = isFallback ? null : captionKeyFor(state);
  const caption = captionKey ? tr(captionKey, { name: state.readbackName ?? '' }) : null;

  return (
    <div
      className="voice-layer"
      data-testid="voice-layer"
      data-voice-mode={state.mode}
      lang={htmlLangFor(locale)}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-sm, 8px)',
        padding: 'var(--space-md, 16px)',
        // 字幕・案内は操作を妨げない。ボタンだけ個別に pointer-events を戻す。
        pointerEvents: 'none',
      }}
    >
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
