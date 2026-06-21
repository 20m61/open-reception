/**
 * カメラフレームから QR をデコードする純化部 (issue #98, increment 2)。
 *
 * getUserMedia / Canvas / setInterval などの副作用から「1 フレームの画素 →
 * QR テキスト」変換だけを切り出し、ユニットテスト可能にする。実カメラ依存部
 * （ZxingQrScanner の getUserMedia 周り）は #65 の実機検証へスタックする。
 *
 * jsQR（Apache-2.0, zero-dependency, WASM なし）をデコーダに用いる。
 * 画素データはローカル処理のみ・非送信・非保存（録画 / 画像保存をしない）。
 */
import jsQR from 'jsqr';

/** Canvas からデコードに必要な最小限のフレーム表現（RGBA 連続バイト列）。 */
export type RgbaFrame = {
  /** RGBA 4 バイト/画素の連続バイト列（Canvas getImageData().data 互換）。 */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
};

/**
 * 1 フレームから QR テキストを取り出す。検出できなければ null
 * （= まだ写っていない / 読み取り途中。エラーではない）。
 *
 * jsQR は反転（白黒反転）QR にも対応するため inversionAttempts: 'attemptBoth' を使う。
 */
export function decodeQrFromFrame(frame: RgbaFrame): string | null {
  const { data, width, height } = frame;
  if (width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) return null;
  const text = result.data;
  return typeof text === 'string' && text.length > 0 ? text : null;
}
