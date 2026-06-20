/**
 * QR スキャナの mock 実装 (issue #98, increment 1)。
 *
 * 実カメラ + デコードライブラリ（@zxing 等）の採用は increment 2（docs/qr-checkin-design.md
 * §5/§6）。inc1 では QrScanner interface を満たす mock でフロー・エラー・確認画面を完成させる。
 *
 * - 与えた payload を一定遅延後に onResult へ渡す（読み取り成功のシミュレート）。
 * - error を与えると onError を呼ぶ（カメラ拒否 / デコード失敗 / タイムアウトの再現）。
 * - 新規 runtime 依存は追加しない（標準 timer のみ）。
 */
import type { QrScanner, ScanError } from '@/domain/checkin/scanner';

export type MockQrScannerOptions = {
  /** 検出させる QR テキスト（URL or 生 token）。 */
  payload?: string;
  /** 代わりに発火させるエラー（payload より優先）。 */
  error?: ScanError;
  /** 検出 / エラーまでの遅延 ms（既定 300）。 */
  delayMs?: number;
};

export class MockQrScanner implements QrScanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: MockQrScannerOptions;

  constructor(options: MockQrScannerOptions = {}) {
    this.options = options;
  }

  async start(
    onResult: (text: string) => void,
    onError: (error: ScanError) => void,
  ): Promise<void> {
    const { payload, error, delayMs = 300 } = this.options;
    this.clear();
    this.timer = setTimeout(() => {
      if (error) {
        onError(error);
        return;
      }
      if (payload !== undefined) onResult(payload);
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
