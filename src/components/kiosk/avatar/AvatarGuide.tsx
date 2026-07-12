'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { ReceptionState } from '@/domain/reception/state';
import { deriveAvatarState } from '@/domain/reception/ui-contract';
import { resolveMotionUrl, type MotionKey } from '@/domain/motion/types';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { speak, type SpeakSettings } from '../speech';
import { AvatarFallbackImage } from './fallback-image';
import { resolveAvatarVisual } from './visual';
import { avatarGuidanceFor, type AvatarGuidance } from './guidance';

/**
 * VrmAvatarViewer は viewer 本体 + avatar サブモジュール（lip-sync / vrm-expression /
 * vrm-pose / resource-tracker）を含むため `next/dynamic` で kiosk 初期チャンクから分離する
 * (#196)。three.js / three-vrm 本体は従来どおり viewer 内部でさらに動的 import される。
 * `resolveAvatarVisual` により VRM 未設定時はこのチャンク自体を読み込まない。
 * ローディング中は null（コンテナが aspect-ratio を確保しておりレイアウトシフトしない。
 * 従来もロード完了までは透明 canvas だったため見た目の変化はない）。
 */
const VrmAvatarViewer = dynamic(
  () => import('../VrmAvatarViewer').then((mod) => mod.VrmAvatarViewer),
  { ssr: false, loading: () => null },
);

/**
 * 受付状態と同期したアバター案内コンポーネント (issue #123 / Epic #119)。
 *
 * 責務:
 *  - #120 の `deriveAvatarState(screenState)` を購読し、状態に応じた表情/モーション・
 *    発話・字幕・軽い誘導を提示する（写像ロジックは avatar/guidance.ts の純関数）。
 *  - 音声が出ない/出せない場合も「字幕」で同内容を表示する（subtitle は常に表示）。
 *  - VRM ロード失敗時は VrmAvatarViewer が静止画/プレースホルダへ落ち、本コンポーネントは
 *    さらにテキスト案内（fallbackText）で内容を保証する。
 *  - チャットドロワー表示中も操作を遮らないよう、オーバーレイは pointer-events: none。
 *
 * 配線方針（KioskFlow へは本トラックでは触らない / #121 のスロット待ち）:
 *  - KioskFlow が保持する screenState をそのまま `screenState` に渡す。
 *  - locale は受付の言語設定（#103）から、TTS 設定は管理設定（#5/#28）から渡す。
 *  - VRM/静止画 URL・モーションマップは端末設定（#27/#31）から渡す。
 *
 * 本コンポーネントは状態を所有しない（screenState の導出のみ）。スタイルはインラインで
 * 完結させ globals.css は触らない（#121 のスコープ）。
 */
export type AvatarGuideProps = {
  /** 受付フローの画面状態。ここから avatarState を導出する（state は持たない）。 */
  screenState: ReceptionState;
  /** 表示言語（#103）。未指定は既定 locale。 */
  locale?: Locale;
  /** VRM モデル URL（無ければ静止画/プレースホルダ）。実アセット検証は #65。 */
  vrmUrl?: string;
  /** VRM 不可/失敗時の静止画 URL。 */
  fallbackImageUrl?: string;
  /** モーションキー → 解決済みモーション URL（#31）。実再生は #65。 */
  motionUrls?: Partial<Record<MotionKey, string>>;
  /** 既定モーション URL（キー未割当時の fallback）。 */
  defaultMotionUrl?: string;
  /** TTS 設定（#5/#28）。未指定/無効なら音声は出さず字幕のみ。 */
  ttsSettings?: SpeakSettings;
  className?: string;
};

export function AvatarGuide({
  screenState,
  locale = DEFAULT_LOCALE,
  vrmUrl,
  fallbackImageUrl,
  motionUrls,
  defaultMotionUrl,
  ttsSettings,
  className,
}: AvatarGuideProps) {
  const avatarState = deriveAvatarState(screenState);
  const guidance: AvatarGuidance = useMemo(
    () => avatarGuidanceFor(avatarState, locale),
    [avatarState, locale],
  );

  const motionUrl = resolveMotionUrl(guidance.motionKey, motionUrls ?? {}, defaultMotionUrl);

  // 表示手段の決定（#196）: viewer（遅延チャンク）/ 静止画 / プレースホルダ。
  const visual = resolveAvatarVisual(vrmUrl, fallbackImageUrl);

  // 発話中フラグ（簡易リップシンク #5）。発話の開始/終了で口パクの ON/OFF を切替える。
  const [speaking, setSpeaking] = useState(false);

  // TTS が有効なら発話する。失敗/無効でも字幕で同内容を保証するためフローは止めない。
  useEffect(() => {
    if (!ttsSettings) return;
    speak(guidance.speech, ttsSettings, {
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
    });
    // 状態遷移・アンマウント時は口を閉じる（onEnd が来ない場合の保険）。
    return () => setSpeaking(false);
  }, [guidance.speech, ttsSettings]);

  const voiceless = !ttsSettings || !ttsSettings.ttsEnabled;

  return (
    <div
      className={className}
      data-testid="avatar-guide"
      data-avatar-state={avatarState}
      data-screen-state={screenState}
      data-cue={guidance.cue}
      data-expression={guidance.expression}
      style={containerStyle}
    >
      <div style={viewerStyle} aria-hidden="true">
        {/* VRM 設定時のみ遅延チャンクをマウントする（#196）。未設定時は viewer を経由せず
            静止画/プレースホルダを直接出し、three/viewer のコードを一切読み込まない。
            VRM ロード失敗時の静止画 fallback は viewer 内部で従来どおり処理される。 */}
        {visual === 'viewer' ? (
          <VrmAvatarViewer
            vrmUrl={vrmUrl}
            fallbackImageUrl={fallbackImageUrl}
            motionUrl={motionUrl}
            expression={guidance.expression}
            speaking={speaking}
            avatarState={avatarState}
            className={undefined}
          />
        ) : null}
        {visual === 'image' && fallbackImageUrl ? (
          <AvatarFallbackImage src={fallbackImageUrl} />
        ) : null}
        {/* VRM も静止画も無い場合のプレースホルダ。案内文言は下の字幕（avatar-subtitle）が
            常時表示・読み上げ（aria-live）するため、ここで文言を重複表示しない。AI 受付で
            あることを示す装飾バッジのみを置く（#123 / アバター未配置時の字幕重複を解消）。 */}
        {visual === 'placeholder' ? (
          <div data-testid="avatar-placeholder" aria-hidden="true" style={placeholderStyle}>
            <span style={placeholderBadgeStyle}>AI</span>
          </div>
        ) : null}
      </div>

      {/* 字幕。音声の有無に関わらず常に表示し、音声が出せない場合も同内容を伝える。 */}
      <p
        data-testid="avatar-subtitle"
        data-voiceless={voiceless ? 'true' : 'false'}
        lang={locale}
        // 案内は live region で読み上げ可能にしつつ、視覚字幕としても見せる。
        aria-live="polite"
        style={subtitleStyle}
      >
        {guidance.subtitle}
      </p>
    </div>
  );
}

// チャットドロワー等の上に重ねても操作を遮らないよう pointer-events を無効化する。
const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  pointerEvents: 'none',
};

const viewerStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: 360,
  aspectRatio: '3 / 4',
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  maxWidth: 480,
  padding: '8px 16px',
  textAlign: 'center',
  fontSize: 20,
  lineHeight: 1.4,
  borderRadius: 12,
  // #329: 字幕の暗幕オーバーレイと白インクを exact value で単一ソース化。
  background: 'var(--color-scrim)',
  color: 'var(--color-on-scrim)',
};

const placeholderStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const placeholderBadgeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40%',
  aspectRatio: '1 / 1',
  borderRadius: '9999px',
  // #329: ごく薄い地色を exact value で単一ソース化。ボーダーは白ボーダー収れん
  // （0.15 → --color-border-strong=0.16、承認済み α 差分）。フォールバックは
  // --color-muted が :root に常に定義済みのため除去しても描画は不変。
  background: 'var(--color-surface-faint)',
  border: '1px solid var(--color-border-strong)',
  color: 'var(--color-muted)',
  fontSize: 28,
  fontWeight: 700,
  letterSpacing: '0.05em',
};
