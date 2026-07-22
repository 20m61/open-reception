import { describe, expect, it } from 'vitest';
import { InjectableQrScanner, debugScannerFromSearch } from './qr-injection';
import type { ScanError } from '@/domain/checkin/scanner';

describe('InjectableQrScanner (#363 カメラなしで payload を注入する経路)', () => {
  it('start 後に inject(payload) で onResult を発火する（実カメラ不要）', async () => {
    const scanner = new InjectableQrScanner();
    const results: string[] = [];
    await scanner.start(
      (text) => results.push(text),
      () => {},
    );
    scanner.inject('RESV_TOKEN_ABC');
    expect(results).toEqual(['RESV_TOKEN_ABC']);
  });

  it('事前 seed した payload は start 時に即発火する（デモ再現/デバッグ入力）', async () => {
    const scanner = new InjectableQrScanner('SEEDED_TOKEN');
    const results: string[] = [];
    await scanner.start(
      (text) => results.push(text),
      () => {},
    );
    expect(results).toEqual(['SEEDED_TOKEN']);
  });

  it('stop 後は inject しても発火しない（カメラ解放と同じく購読解除）', async () => {
    const scanner = new InjectableQrScanner();
    const results: string[] = [];
    await scanner.start(
      (text) => results.push(text),
      () => {},
    );
    await scanner.stop();
    scanner.inject('LATE');
    expect(results).toEqual([]);
  });

  it('failWith でエラー経路（カメラ拒否/デコード失敗）も再現できる', async () => {
    const scanner = new InjectableQrScanner();
    const errors: ScanError[] = [];
    await scanner.start(
      () => {},
      (e) => errors.push(e),
    );
    scanner.failWith({ kind: 'decode_failed', message: 'x' });
    expect(errors).toEqual([{ kind: 'decode_failed', message: 'x' }]);
  });
});

describe('debugScannerFromSearch (#363 デバッグ入力: ?debugScanPayload=)', () => {
  it('debugScanPayload があれば seed 済みスキャナを返す', async () => {
    const scanner = debugScannerFromSearch('?debugScanPayload=TOKEN_XYZ');
    expect(scanner).toBeInstanceOf(InjectableQrScanner);
    const results: string[] = [];
    await scanner!.start(
      (t) => results.push(t),
      () => {},
    );
    expect(results).toEqual(['TOKEN_XYZ']);
  });

  it('パラメータ無しは undefined（実カメラ経路は無変更）', () => {
    expect(debugScannerFromSearch('')).toBeUndefined();
    expect(debugScannerFromSearch('?foo=bar')).toBeUndefined();
  });

  it('空の payload は undefined（誤起動しない）', () => {
    expect(debugScannerFromSearch('?debugScanPayload=')).toBeUndefined();
  });

  it('本番ビルドでは payload 付きでも undefined（token の URL 露出を防ぐ）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(debugScannerFromSearch('?debugScanPayload=TOKEN_XYZ')).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
