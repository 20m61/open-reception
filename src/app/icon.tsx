import { ImageResponse } from 'next/og';

/**
 * アプリアイコン (issue #331)。
 *
 * `next/og` の `ImageResponse`（Next.js 同梱、追加 npm 依存なし）でベクター図形から
 * 生成する。外部フォント・外部画像は一切使わない（CSP img-src/font-src の対象外で完結）。
 *
 * テナントロゴ（#88, `/admin/branding`）とは独立した「プロダクト」アイコン。
 * 色は `src/app/globals.css` のデザイントークンと揃える
 * （`--color-bg: #0b1120`, `--brand-accent: #38bdf8`。トークン自体は読み取りのみで編集しない）。
 *
 * この 512x512 の単一アセットを `manifest.ts` から `purpose: 'any'` と `purpose: 'maskable'`
 * の両方で参照する。マスク対応のため、図柄は外周 ~20%（マスカブルアイコンの標準セーフゾーン）
 * を空けたフルブリード背景にし、角丸は焼き込まない（OS 側のマスク形状に委ねる）。
 */
export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

const BG = '#0b1120';
const ACCENT = '#38bdf8';

/**
 * ブランド非依存の抽象マーク（応答/呼び出しを想起させる三日月状の図形）を描画する。
 * `icon.tsx` / `apple-icon.tsx` の双方でキャンバスサイズだけ変えて再利用し、見た目を揃える。
 */
export function renderMark(canvasSize: number) {
  const mark = Math.round(canvasSize * 0.58);
  const notch = Math.round(canvasSize * 0.4);
  const markOffset = Math.round((canvasSize - mark) / 2);
  const notchLeft = markOffset + Math.round(mark * 0.32);
  const notchTop = markOffset - Math.round(notch * 0.12);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: BG,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: markOffset,
          top: markOffset,
          width: mark,
          height: mark,
          borderRadius: '50%',
          background: ACCENT,
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: notchLeft,
          top: notchTop,
          width: notch,
          height: notch,
          borderRadius: '50%',
          background: BG,
          display: 'flex',
        }}
      />
    </div>
  );
}

export default function Icon() {
  return new ImageResponse(renderMark(size.width), { ...size });
}
