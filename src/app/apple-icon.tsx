import { ImageResponse } from 'next/og';
import { renderMark } from './icon';

/**
 * iOS ホーム画面用アイコン (apple-touch-icon) (issue #331)。
 *
 * 180x180 は Apple 推奨サイズ（iPad/iPhone 共通の高解像度想定）。
 * `icon.tsx` と同じ抽象マーク（`renderMark`）をキャンバスサイズだけ変えて再利用し、
 * ブラウザタブアイコンとホーム画面アイコンの見た目を一致させる。
 * iOS が角丸クリップ・光沢を自動適用するため、ここでも角丸は焼き込まない。
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(renderMark(size.width), { ...size });
}
