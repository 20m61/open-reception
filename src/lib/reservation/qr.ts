/**
 * 来訪予約 QR 画像レンダリング (issue #97, increment 2)。
 *
 * 予約 token の checkin URL（src/domain/reservation/token.ts の buildReservationCheckinUrl）を
 * QR 画像（SVG）へ描画する。サーバ側生成を基本にし、QR に載せるのは token 参照 URL のみ。
 * 氏名・会社名・担当者名などの PII は一切載せない（docs/visit-reservation-design.md §セキュリティ,
 * docs/license-privacy-guide.md §2.1）。
 *
 * 採用ライブラリ: qrcode-generator@2.0.4（SPDX: MIT・依存なし・商用利用可）。
 * SVG 生成そのもの（モジュール行列 → <svg> 文字列）は純関数として切り出し、ライブラリに
 * 依存しない形でテストする。ライブラリは「文字列 → モジュール行列」の符号化のみに使う。
 */
import qrcode from 'qrcode-generator';
import { buildReservationCheckinUrl } from '@/domain/reservation/token';
import type { ReservationToken } from '@/domain/reservation/types';

/** QR の誤り訂正レベル。受付端末のスキャン安定性のため標準 M（約 15%）。 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export type QrRenderOptions = {
  /** 1 モジュール（セル）の辺の長さ（px）。既定 6。 */
  cellSize?: number;
  /** 静寂域（quiet zone）のモジュール数。既定 4（QR 仕様の推奨）。 */
  margin?: number;
  /** 誤り訂正レベル。既定 'M'。 */
  errorCorrection?: QrErrorCorrection;
  /** 前景色（暗モジュール）。既定 '#000000'。 */
  dark?: string;
  /** 背景色。既定 '#ffffff'（透過は受付端末のスキャン失敗を避けるため使わない）。 */
  light?: string;
  /** SVG の aria-label。用途に応じて差し替える（既定は予約 checkin 用）。 */
  ariaLabel?: string;
};

const DEFAULTS = {
  cellSize: 6,
  margin: 4,
  errorCorrection: 'M' as QrErrorCorrection,
  dark: '#000000',
  light: '#ffffff',
};

/** QR モジュール行列（true = 暗セル）。符号化結果を表す純データ。 */
export type QrMatrix = readonly (readonly boolean[])[];

/** XML 属性値として安全な色文字列か（簡易検証。任意のマークアップ混入を防ぐ）。 */
function isSafeColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(value) || /^[a-zA-Z]+$/.test(value);
}

/**
 * モジュール行列を SVG 文字列へ描画する純関数（qrcode-generator に依存しない）。
 *
 * - 余白（margin）込みのビューポートを作り、暗セルだけを矩形で描く。
 * - 背景は単色矩形で塗る（透過させない）。
 * - 色はサニタイズ済みの値のみ受け付け、未許可なら既定色にフォールバックする。
 */
export function renderMatrixToSvg(matrix: QrMatrix, options: QrRenderOptions = {}): string {
  const cellSize = options.cellSize ?? DEFAULTS.cellSize;
  const margin = options.margin ?? DEFAULTS.margin;
  const dark = isSafeColor(options.dark ?? '') ? (options.dark as string) : DEFAULTS.dark;
  const light = isSafeColor(options.light ?? '') ? (options.light as string) : DEFAULTS.light;
  // aria-label は属性値として無害化する（任意マークアップ混入を防ぐ）。
  const ariaLabel = (options.ariaLabel ?? 'reservation check-in QR code').replace(/[<>"&]/g, '');

  const count = matrix.length;
  const dimension = (count + margin * 2) * cellSize;

  const rects: string[] = [];
  for (let row = 0; row < count; row += 1) {
    const line = matrix[row] ?? [];
    for (let col = 0; col < line.length; col += 1) {
      if (!line[col]) continue;
      const x = (col + margin) * cellSize;
      const y = (row + margin) * cellSize;
      rects.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}"/>`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="${ariaLabel}">` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g>` +
    `</svg>`
  );
}

/** 文字列を QR モジュール行列に符号化する（qrcode-generator を使う唯一の箇所）。 */
export function encodeToMatrix(
  text: string,
  errorCorrection: QrErrorCorrection = DEFAULTS.errorCorrection,
): QrMatrix {
  // typeNumber 0 = データ量に応じて自動選択。
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col += 1) {
      line.push(qr.isDark(row, col));
    }
    matrix.push(line);
  }
  return matrix;
}

/** 任意のテキストを QR の SVG 文字列へ。汎用（PII を渡さないのは呼び出し側の責務）。 */
export function renderTextToQrSvg(text: string, options: QrRenderOptions = {}): string {
  const matrix = encodeToMatrix(text, options.errorCorrection ?? DEFAULTS.errorCorrection);
  return renderMatrixToSvg(matrix, options);
}

/** SVG 文字列を data URL（image/svg+xml; base64）へ。img src / ダウンロードに使う。 */
export function svgToDataUrl(svg: string): string {
  const base64 = Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * 予約 token の checkin URL を QR の SVG へ描画する（このモジュールの主用途）。
 * 載せるのは URL（= token 参照）のみ。PII は含めない。
 */
export function renderReservationQrSvg(
  baseUrl: string,
  token: ReservationToken,
  options: QrRenderOptions = {},
): string {
  const url = buildReservationCheckinUrl(baseUrl, token);
  return renderTextToQrSvg(url, options);
}

/** 予約 token の QR を data URL で返す（API レスポンス / img 表示用）。 */
export function renderReservationQrDataUrl(
  baseUrl: string,
  token: ReservationToken,
  options: QrRenderOptions = {},
): string {
  return svgToDataUrl(renderReservationQrSvg(baseUrl, token, options));
}
