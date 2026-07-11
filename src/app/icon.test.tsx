import { describe, expect, it } from 'vitest';
import Icon, { renderMark, size, contentType } from './icon';
import AppleIcon, { size as appleSize, contentType as appleContentType } from './apple-icon';

/**
 * アプリアイコンの検証 (issue #331)。
 *
 * `ImageResponse`（next/og）自体の PNG レンダリング（satori/resvg の WASM パイプライン）は
 * 重い実行系であり、実際の応答は `next build` が icon/apple-icon ルートを生成する過程で
 * 検証される（quality-gate --pr の build ステップ）。ここでは:
 *   - サイズ/contentType のメタデータが manifest.ts と整合していること
 *   - 図柄を組み立てる純粋関数 `renderMark` が、maskable セーフゾーン（外周 ~20%）を
 *     踏まえた正しい幾何（真円・キャンバス内に収まる）を返すこと
 * を対象にする。
 */
describe('icon size/contentType (#331)', () => {
  it('icon.tsx は 512x512 の PNG（manifest.ts の宣言サイズと一致）', () => {
    expect(size).toEqual({ width: 512, height: 512 });
    expect(contentType).toBe('image/png');
  });

  it('apple-icon.tsx は Apple 推奨の 180x180 PNG', () => {
    expect(appleSize).toEqual({ width: 180, height: 180 });
    expect(appleContentType).toBe('image/png');
  });

  it('Icon / AppleIcon のデフォルトエクスポートは関数（ImageResponse を返すルートハンドラ）', () => {
    expect(typeof Icon).toBe('function');
    expect(typeof AppleIcon).toBe('function');
  });
});

type MarkStyle = {
  position?: string;
  left?: number;
  top?: number;
  width?: number | string;
  height?: number | string;
  borderRadius?: string;
  background?: string;
};

type MarkElement = {
  props: {
    style: MarkStyle;
    children?: MarkElement | MarkElement[];
  };
};

function childrenArray(el: MarkElement): MarkElement[] {
  const c = el.props.children;
  if (!c) return [];
  return Array.isArray(c) ? c : [c];
}

describe('renderMark: maskable セーフゾーンを満たす幾何 (#331)', () => {
  it('背景キャンバスは角丸を焼き込まない全面塗り（OS 側のマスクに委ねる）', () => {
    const root = renderMark(512) as unknown as MarkElement;
    expect(root.props.style.background).toBe('#0b1120');
    expect(root.props.style.borderRadius).toBeUndefined();
  });

  it('メインの円は直径 60% 未満に収め、セーフゾーン（外周 ~20%）内に収まる', () => {
    const root = renderMark(512) as unknown as MarkElement;
    const [mainCircle] = childrenArray(root);
    expect(mainCircle).toBeDefined();
    if (!mainCircle) throw new Error('unreachable');
    const w = Number(mainCircle.props.style.width);
    const h = Number(mainCircle.props.style.height);
    expect(w).toBe(h); // 真円
    expect(w).toBeLessThanOrEqual(512 * 0.6);
    const left = Number(mainCircle.props.style.left);
    const top = Number(mainCircle.props.style.top);
    // キャンバス内に収まる（負の座標にはみ出さない）
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + w).toBeLessThanOrEqual(512);
    expect(top + h).toBeLessThanOrEqual(512);
    expect(mainCircle.props.style.borderRadius).toBe('50%');
  });

  it('サイズを変えても同じ比率で幾何が再計算される（icon/apple-icon で共有可能）', () => {
    const root180 = renderMark(180) as unknown as MarkElement;
    const [mainCircle] = childrenArray(root180);
    expect(mainCircle).toBeDefined();
    if (!mainCircle) throw new Error('unreachable');
    const w = Number(mainCircle.props.style.width);
    expect(w).toBeLessThanOrEqual(180 * 0.6);
    expect(w).toBeGreaterThan(0);
  });
});
