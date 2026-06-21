/**
 * 実カメラ QR スキャナアダプタ (issue #98, increment 2)。
 *
 * QrScanner interface（src/domain/checkin/scanner.ts）の**実デコード実装**。
 * getUserMedia でカメラ映像を取得し、Canvas へ低解像度で描画したフレームを
 * jsQR（Apache-2.0, zero-dependency, WASM なし）でデコードして token 参照 URL を読む。
 *
 * 設計（docs/qr-checkin-design.md §5/§6/§7）:
 *   - interface は inc1 から不変。CheckinFlow へ注入し、mock と差し替え可能。
 *   - 検出後も即時呼び出しはしない（確認フローは CheckinFlow が担保）。
 *   - フォールバック: カメラ未対応 / 権限拒否 / 取得失敗は onError('camera_denied')、
 *     一定時間検出できなければ onError('timeout')。どちらも CheckinFlow が安全に倒す。
 *   - 映像・フレームは**ローカル処理のみ・非送信・非保存**（録画 / 画像保存をしない）。
 *   - 実機（iPad Safari / PWA）での読み取り検証は #65 にスタックする。
 */
import type { QrScanner, ScanError } from '@/domain/checkin/scanner';
import { decodeQrFromFrame } from './decode-frame';

export type CameraQrScannerOptions = {
  /** デコード試行間隔 ms（既定 250）。 */
  sampleIntervalMs?: number;
  /** 検出できないまま経過したら timeout する ms（既定 30000、0 で無効）。 */
  timeoutMs?: number;
  /** 内部処理解像度の幅（既定 480）。高すぎると iPad で負荷増。 */
  frameWidth?: number;
  /** 内部処理解像度の高さ（既定 360）。 */
  frameHeight?: number;
};

const DEFAULTS = {
  sampleIntervalMs: 250,
  timeoutMs: 30_000,
  frameWidth: 480,
  frameHeight: 360,
} as const;

function scanError(kind: ScanError['kind'], message: string): ScanError {
  return { kind, message };
}

export class CameraQrScanner implements QrScanner {
  private readonly options: Required<CameraQrScannerOptions>;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: CameraQrScannerOptions = {}) {
    this.options = {
      sampleIntervalMs: options.sampleIntervalMs ?? DEFAULTS.sampleIntervalMs,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      frameWidth: options.frameWidth ?? DEFAULTS.frameWidth,
      frameHeight: options.frameHeight ?? DEFAULTS.frameHeight,
    };
  }

  async start(
    onResult: (text: string) => void,
    onError: (error: ScanError) => void,
  ): Promise<void> {
    this.stopped = false;

    const md =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      // 未対応ブラウザ。通常受付へフォールバックできるよう camera_denied で倒す。
      onError(scanError('camera_denied', 'カメラを利用できない環境です。'));
      return;
    }

    let stream: MediaStream;
    try {
      // 背面カメラ優先（QR をかざしやすい）。取得映像はローカルでのみ処理する。
      stream = await md.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch {
      // 権限拒否 / デバイスなし / 取得失敗。通常受付へフォールバック可能。
      onError(scanError('camera_denied', 'カメラの使用が許可されませんでした。'));
      return;
    }

    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    const { frameWidth, frameHeight } = this.options;
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.canvas = canvas;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    await video.play().catch(() => undefined);

    if (this.stopped || !ctx) {
      if (!ctx) onError(scanError('decode_failed', 'フレームを処理できませんでした。'));
      void this.stop();
      return;
    }

    let delivered = false;
    const deliverResult = (text: string) => {
      if (delivered || this.stopped) return;
      delivered = true;
      onResult(text);
    };

    if (this.options.timeoutMs > 0) {
      this.deadlineTimer = setTimeout(() => {
        if (delivered || this.stopped) return;
        delivered = true;
        onError(scanError('timeout', 'QR を読み取れませんでした。'));
      }, this.options.timeoutMs);
    }

    this.sampleTimer = setInterval(() => {
      if (delivered || this.stopped || !this.video) return;
      try {
        ctx.drawImage(this.video, 0, 0, frameWidth, frameHeight);
        const { data } = ctx.getImageData(0, 0, frameWidth, frameHeight);
        const text = decodeQrFromFrame({ data, width: frameWidth, height: frameHeight });
        if (text) deliverResult(text);
      } catch {
        /* 1 フレームの失敗は致命的でない（次のサンプルで回復）。 */
      }
    }, this.options.sampleIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.canvas = null;
  }
}
