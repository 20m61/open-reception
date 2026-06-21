import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeQrFromFrame } from './decode-frame';

// jsQR をモックして「画素 → token テキスト」変換の純化部だけを検証する
// （実カメラ依存部は #65 の実機検証へスタック）。
const jsQRMock = vi.hoisted(() => vi.fn());
vi.mock('jsqr', () => ({ default: jsQRMock }));

function frame(width: number, height: number) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

describe('decodeQrFromFrame (issue #98, increment 2)', () => {
  afterEach(() => {
    jsQRMock.mockReset();
  });

  // jsqr モジュール（大きめ）の初回 transform が並列フル実行下で遅くなり得るため、
  // この最初のケースだけ余裕のあるタイムアウトを与える（純化部のロジック自体は同期・即時）。
  it('jsQR が検出したテキスト（checkin URL）をそのまま返す', () => {
    jsQRMock.mockReturnValue({ data: 'https://example.com/kiosk/checkin?rt=abc123' });
    const f = frame(480, 360);
    expect(decodeQrFromFrame(f)).toBe('https://example.com/kiosk/checkin?rt=abc123');
    // jsQR には RGBA バイト列・幅・高さ・反転試行オプションを渡す。
    expect(jsQRMock).toHaveBeenCalledWith(f.data, 480, 360, {
      inversionAttempts: 'attemptBoth',
    });
  }, 30_000);

  it('QR 未検出（null）なら null を返す（エラーではない・読み取り途中）', () => {
    jsQRMock.mockReturnValue(null);
    expect(decodeQrFromFrame(frame(480, 360))).toBeNull();
  });

  it('検出しても data が空文字なら null（無効な結果は読み取り扱いしない）', () => {
    jsQRMock.mockReturnValue({ data: '' });
    expect(decodeQrFromFrame(frame(480, 360))).toBeNull();
  });

  it('幅・高さが 0 以下なら jsQR を呼ばず null', () => {
    expect(decodeQrFromFrame(frame(0, 360))).toBeNull();
    expect(decodeQrFromFrame({ data: new Uint8ClampedArray(0), width: 10, height: -1 })).toBeNull();
    expect(jsQRMock).not.toHaveBeenCalled();
  });

  it('バイト列が width*height*4 に満たなければ jsQR を呼ばず null（不正フレーム）', () => {
    const broken = { data: new Uint8ClampedArray(10), width: 480, height: 360 };
    expect(decodeQrFromFrame(broken)).toBeNull();
    expect(jsQRMock).not.toHaveBeenCalled();
  });
});
