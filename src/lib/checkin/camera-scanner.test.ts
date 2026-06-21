import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraQrScanner } from './camera-scanner';
import type { ScanError } from '@/domain/checkin/scanner';

// jsQR は decode-frame 経由でのみ使う。実カメラのフレーム処理（getUserMedia /
// Canvas / video）の実機検証は #65 にスタックする。ここでは getUserMedia 前の
// フォールバック分岐（未対応 / 権限拒否）と stop の冪等性のみを検証する。
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const originalNavigator = globalThis.navigator;

function restoreNavigator() {
  if (originalNavigator === undefined) {
    // jsdom 以外（node 環境）では navigator が無いので消す。
    Reflect.deleteProperty(globalThis as Record<string, unknown>, 'navigator');
  } else {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  }
}

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
}

describe('CameraQrScanner フォールバック (issue #98, increment 2)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    restoreNavigator();
    vi.restoreAllMocks();
  });

  it('mediaDevices が無い環境は camera_denied で倒す（未対応ブラウザ）', async () => {
    setNavigator({});
    const scanner = new CameraQrScanner();
    const onResult = vi.fn();
    const errors: ScanError[] = [];

    await scanner.start(onResult, (e) => errors.push(e));

    expect(onResult).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('camera_denied');
  });

  it('getUserMedia が無い環境も camera_denied で倒す', async () => {
    setNavigator({ mediaDevices: {} });
    const scanner = new CameraQrScanner();
    const errors: ScanError[] = [];

    await scanner.start(vi.fn(), (e) => errors.push(e));

    expect(errors[0]?.kind).toBe('camera_denied');
  });

  it('getUserMedia が reject したら camera_denied（権限拒否 / デバイスなし）', async () => {
    setNavigator({
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    });
    const scanner = new CameraQrScanner();
    const errors: ScanError[] = [];

    await scanner.start(vi.fn(), (e) => errors.push(e));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('camera_denied');
    // 権限拒否でもフォールバックできるよう onResult は呼ばれない。
  });

  it('start 前後で stop を呼んでもクラッシュしない（冪等・リソース解放）', async () => {
    const scanner = new CameraQrScanner();
    await expect(scanner.stop()).resolves.toBeUndefined();
    await expect(scanner.stop()).resolves.toBeUndefined();
  });

  it('stop 後に開始した getUserMedia の解決はトラックを停止して破棄する', async () => {
    const track = { stop: vi.fn() };
    let resolveStream: ((s: unknown) => void) | undefined;
    const getUserMedia = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveStream = resolve;
      }),
    );
    setNavigator({ mediaDevices: { getUserMedia } });

    const scanner = new CameraQrScanner();
    const onResult = vi.fn();
    const startPromise = scanner.start(onResult, vi.fn());
    // start 内で getUserMedia 待ちのうちに stop（画面離脱）。
    await scanner.stop();
    resolveStream?.({ getTracks: () => [track] });
    await startPromise;

    expect(track.stop).toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
