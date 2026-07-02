/**
 * アバター表示手段の決定（#196 kiosk バンドル遅延化）。
 *
 * VrmAvatarViewer（three.js / @pixiv/three-vrm を内包）は `next/dynamic` で遅延ロードする
 * ため、「viewer をマウントするか」の判定はチャンク読込の有無に直結する。ここを純関数に
 * 切り出して不変条件をユニットテストで固定する:
 *  - vrmUrl が無ければ viewer チャンクを一切読み込まない（'image' / 'placeholder'）。
 *  - vrmUrl があるときのみ 'viewer'（ロード失敗時の静止画 fallback は viewer 内部で処理）。
 */
export type AvatarVisual = 'viewer' | 'image' | 'placeholder';

export function resolveAvatarVisual(vrmUrl?: string, fallbackImageUrl?: string): AvatarVisual {
  if (vrmUrl) return 'viewer';
  if (fallbackImageUrl) return 'image';
  return 'placeholder';
}
