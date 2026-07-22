/**
 * QR ペイロードの注入点 (issue #363 injection point 3)。
 *
 * CheckinFlow のカメラスキャナ（`QrScanner`）は元々注入可能だが、実カメラ無しで payload を
 * 流し込む手段が無く「Mock 注入点不足で再現不能」だった (#363 Inc1 申し送り)。本モジュールは
 * カメラを使わず payload を注入できる `QrScanner` 実装と、`?debugScanPayload=` からデバッグ用
 * スキャナを組み立てるヘルパを提供する。実カメラ経路（CameraQrScanner）は無変更。
 *
 * セキュリティ (#19 / #105): 映像は元々ローカル処理・非送信/非保存。本注入経路も payload 文字列を
 * その場で onResult へ渡すだけで保存しない。QR payload は高エントロピーな reservationToken を
 * 想定し、個人情報は載せない前提（`rules/pii-secret-minimization.md`）。
 */
import type { QrScanner, ScanError } from '@/domain/checkin/scanner';

/**
 * カメラ無しで payload / エラーを注入できる `QrScanner`。
 * - コンストラクタに payload を渡すと start 時に即発火（デモ再現・デバッグ入力）。
 * - start 後に `inject(payload)` / `failWith(error)` で任意タイミングにも流せる。
 * - stop 後は購読解除され、以後の inject/failWith は無視される（カメラ解放と同じ挙動）。
 */
export class InjectableQrScanner implements QrScanner {
  private onResult: ((text: string) => void) | null = null;
  private onError: ((error: ScanError) => void) | null = null;
  private started = false;

  constructor(private readonly seededPayload?: string) {}

  async start(
    onResult: (text: string) => void,
    onError: (error: ScanError) => void,
  ): Promise<void> {
    this.onResult = onResult;
    this.onError = onError;
    this.started = true;
    if (this.seededPayload) this.onResult(this.seededPayload);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.onResult = null;
    this.onError = null;
  }

  /** 読み取り成功を注入する（実カメラの onResult 相当）。 */
  inject(payload: string): void {
    if (!this.started || !this.onResult) return;
    this.onResult(payload);
  }

  /** 読み取りエラー（カメラ拒否/デコード失敗/タイムアウト）を注入する。 */
  failWith(error: ScanError): void {
    if (!this.started || !this.onError) return;
    this.onError(error);
  }
}

/**
 * `?debugScanPayload=<token>` が付いていれば、その payload を seed した camera-free スキャナを返す。
 * 付いていない/空のときは undefined（実カメラ経路のまま・非破壊）。E2E タイマー上書き
 * （`?callingStageMs=` 等）と同じデバッグ用クエリの流儀。
 */
export function debugScannerFromSearch(search: string): InjectableQrScanner | undefined {
  const params = new URLSearchParams(search);
  const payload = params.get('debugScanPayload');
  if (!payload) return undefined;
  return new InjectableQrScanner(payload);
}
