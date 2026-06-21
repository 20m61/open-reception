import { describe, expect, it } from 'vitest';
import {
  CHECKIN_ERROR_STATES,
  CHECKIN_STATES,
  isCheckinError,
  isCheckinTerminal,
  transition,
  transitionOrThrow,
  type CheckinState,
} from './state';

describe('checkin state machine (issue #98)', () => {
  it('待機 → 受付方法選択 → QR → カメラ許可 → 読取 → 取得 → 確認 → 呼出 → 完了 の正常系', () => {
    let s: CheckinState = 'idle';
    s = transitionOrThrow(s, 'START');
    expect(s).toBe('selectingMethod');
    s = transitionOrThrow(s, 'CHOOSE_QR');
    expect(s).toBe('checkingCamera');
    s = transitionOrThrow(s, 'CAMERA_GRANTED');
    expect(s).toBe('scanning');
    s = transitionOrThrow(s, 'QR_DETECTED');
    expect(s).toBe('resolving');
    s = transitionOrThrow(s, 'RESERVATION_OK');
    expect(s).toBe('confirming');
    s = transitionOrThrow(s, 'CONFIRM');
    expect(s).toBe('calling');
    s = transitionOrThrow(s, 'CALL_DONE');
    expect(s).toBe('completed');
  });

  it('確認画面を必ず経由する: resolving から calling へ直接遷移できない（確認必須）', () => {
    expect(transition('resolving', 'CONFIRM')).toBeNull();
    // resolving の唯一の前進は confirming（RESERVATION_OK）。
    expect(transition('resolving', 'RESERVATION_OK')).toBe('confirming');
    // calling へ入れるのは confirming の CONFIRM だけ。
    expect(transition('confirming', 'CONFIRM')).toBe('calling');
  });

  it('確認画面でキャンセルできる / 読み直せる', () => {
    expect(transition('confirming', 'CANCEL')).toBe('cancelled');
    expect(transition('confirming', 'RESCAN')).toBe('scanning');
  });

  it('予約取得の失敗を種別ごとに別状態へ区別する', () => {
    expect(transition('resolving', 'RESERVATION_EXPIRED')).toBe('expiredError');
    expect(transition('resolving', 'RESERVATION_USED')).toBe('usedError');
    expect(transition('resolving', 'RESERVATION_REVOKED')).toBe('revokedError');
    expect(transition('resolving', 'RESERVATION_INVALID')).toBe('scanError');
    expect(transition('resolving', 'RESOLVE_NETWORK_ERROR')).toBe('networkError');
  });

  it('カメラ拒否は cameraError へ、不正 QR は scanError へ', () => {
    expect(transition('checkingCamera', 'CAMERA_DENIED')).toBe('cameraError');
    expect(transition('scanning', 'SCAN_ERROR')).toBe('scanError');
  });

  it('実カメラの権限プロンプトは読取開始時に出るため scanning 中の拒否も cameraError へ (increment 2)', () => {
    // CameraQrScanner は scanning に入ってから getUserMedia を呼ぶ。そこでの拒否 /
    // 未対応は scanError ではなく cameraError として区別する（通常受付へフォールバック可）。
    expect(transition('scanning', 'CAMERA_DENIED')).toBe('cameraError');
  });

  it('すべてのエラー状態から通常受付（manualFallback）へフォールバックできる', () => {
    for (const s of CHECKIN_ERROR_STATES) {
      expect(transition(s, 'USE_MANUAL')).toBe('manualFallback');
      expect(transition(s, 'RETRY')).toBe('selectingMethod');
      expect(transition(s, 'RESET')).toBe('idle');
    }
  });

  it('カメラ拒否でも通常受付に戻れる（セキュリティ要件）', () => {
    expect(transition('cameraError', 'USE_MANUAL')).toBe('manualFallback');
  });

  it('受付方法選択で通常受付を選べる', () => {
    expect(transition('selectingMethod', 'CHOOSE_MANUAL')).toBe('manualFallback');
  });

  it('RESET は全状態から idle に戻る（自動リセット・個人情報を残さない）', () => {
    for (const s of CHECKIN_STATES) {
      expect(transition(s, 'RESET')).toBe('idle');
    }
  });

  it('不正遷移は null（呼び出し / 完了直後に勝手に進めない）', () => {
    expect(transition('idle', 'CONFIRM')).toBeNull();
    expect(transition('completed', 'START')).toBeNull();
    expect(transition('confirming', 'QR_DETECTED')).toBeNull();
    expect(transition('manualFallback', 'CONFIRM')).toBeNull();
  });

  it('transitionOrThrow は不正遷移で例外を投げる', () => {
    expect(() => transitionOrThrow('idle', 'CONFIRM')).toThrow(/Invalid checkin transition/);
  });

  it('終端 / エラー判定ヘルパ', () => {
    expect(isCheckinTerminal('completed')).toBe(true);
    expect(isCheckinTerminal('cancelled')).toBe(true);
    expect(isCheckinTerminal('manualFallback')).toBe(true);
    expect(isCheckinTerminal('confirming')).toBe(false);
    expect(isCheckinError('expiredError')).toBe(true);
    expect(isCheckinError('idle')).toBe(false);
  });
});
