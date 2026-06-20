import { describe, expect, it } from 'vitest';
import { asReservationToken } from '@/domain/reservation/types';
import { buildReservationCheckinUrl } from '@/domain/reservation/token';
import {
  encodeToMatrix,
  renderMatrixToSvg,
  renderReservationQrDataUrl,
  renderReservationQrSvg,
  renderTextToQrSvg,
  svgToDataUrl,
  type QrMatrix,
} from './qr';

describe('encodeToMatrix (#97)', () => {
  it('正方の boolean 行列を返す（暗セルが少なくとも 1 つある）', () => {
    const matrix = encodeToMatrix('https://x.example/kiosk/checkin?rt=abc');
    expect(matrix.length).toBeGreaterThan(0);
    for (const row of matrix) expect(row.length).toBe(matrix.length);
    const dark = matrix.flat().filter(Boolean).length;
    expect(dark).toBeGreaterThan(0);
  });

  it('同じ入力からは安定した行列を返す（決定的）', () => {
    const a = encodeToMatrix('same-input');
    const b = encodeToMatrix('same-input');
    expect(a).toEqual(b);
  });
});

describe('renderMatrixToSvg (#97)', () => {
  const matrix: QrMatrix = [
    [true, false],
    [false, true],
  ];

  it('暗セルの数だけ rect を描き、寸法に余白を含める', () => {
    const svg = renderMatrixToSvg(matrix, { cellSize: 10, margin: 1 });
    // 暗セル 2 個 + 背景 1 個 = rect 3 個。
    expect(svg.match(/<rect/g)?.length).toBe(3);
    // (2 + 1*2) * 10 = 40。
    expect(svg).toContain('width="40"');
    expect(svg).toContain('viewBox="0 0 40 40"');
  });

  it('正しい SVG 名前空間と aria 属性を持つ', () => {
    const svg = renderMatrixToSvg(matrix);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
  });

  it('不正な色はサニタイズして既定色にフォールバックする', () => {
    const svg = renderMatrixToSvg(matrix, { dark: '"><script>', light: 'red' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('fill="#000000"'); // 既定の dark
    expect(svg).toContain('fill="red"'); // 許容される単語色
  });
});

describe('svgToDataUrl (#97)', () => {
  it('image/svg+xml の base64 data URL を返す', () => {
    const dataUrl = svgToDataUrl('<svg></svg>');
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(decodeDataUrl(dataUrl)).toBe('<svg></svg>');
  });
});

describe('renderReservation* (#97 PII 非混入)', () => {
  const token = asReservationToken('tok_DETERMINISTIC_123');
  const baseUrl = 'https://reception.example.com';

  it('QR には checkin URL（token 参照）だけが載り、PII は載らない', () => {
    // checkin URL を直接描いた SVG と、予約用ヘルパの SVG が一致する。
    const expected = renderTextToQrSvg(buildReservationCheckinUrl(baseUrl, token));
    const actual = renderReservationQrSvg(baseUrl, token);
    expect(actual).toBe(expected);
    // SVG 自体に PII（氏名/会社名）は出てこない（rect の集合のみ）。
    expect(actual).not.toContain('visitor');
    expect(actual).not.toContain('company');
  });

  it('data URL も生成でき、デコードすると同じ SVG になる', () => {
    const dataUrl = renderReservationQrDataUrl(baseUrl, token);
    expect(decodeDataUrl(dataUrl)).toBe(renderReservationQrSvg(baseUrl, token));
  });
});

/** base64 data URL の本体をデコードする（テスト補助）。 */
function decodeDataUrl(dataUrl: string): string {
  const base64 = dataUrl.split(',')[1] ?? '';
  return Buffer.from(base64, 'base64').toString('utf8');
}
