/**
 * リアルタイム基盤の可用性から「音声受付を提示してよいか」を決める純ロジックのテスト
 * (issue #366 / ADR 0003 の ADR-005)。
 *
 * ADR-005 の要求は 2 つ:
 *   - **ready 判定が通るまでは音声受付を利用可能と表示しない**（起動途中に「音声でどうぞ」と
 *     案内して繋がらない、を防ぐ）
 *   - EC2/ASG の異常時は degraded として扱い、タッチ・QR へフォールバックする
 *
 * `lifecycle.ts` は**接続を試みたあと**の状態（切断・再接続・断念）を持つ。本モジュールは
 * **接続を試みる前**に「そもそも基盤が受け付けられる状態か」を決める。関心事が別なので
 * 状態機械は分けるが、判定は両方を見る（接続を使い果たしていれば基盤が ready でも提示しない）。
 *
 * 設計の指針: **不確かなときは提示しない**。#481（inputModes の宣言を実態に合わせる）と
 * 同じ原則で、できると言って実際にできないことを来訪者に見せない。
 */
import { describe, expect, it } from 'vitest';
import {
  REALTIME_RUNTIME_STATUSES,
  resolveVoiceAvailability,
  isVoicePresentable,
  type RealtimeRuntimeStatus,
} from './runtime-availability';
import type { VoiceTransportLifecycleState } from './lifecycle';

describe('resolveVoiceAvailability — 基盤の状態', () => {
  it('ready なら提示できる', () => {
    expect(resolveVoiceAvailability({ runtime: 'ready', transport: 'idle' })).toBe('available');
  });

  it('starting は「準備中」（利用可能とは表示しない）', () => {
    // 営業開始直後の AMI ブート + アプリ起動（ADR-005 の RTO は数分〜10 分）。
    // 「準備中」は unavailable と区別する: すぐ使えるようになるので案内文言が違う。
    expect(resolveVoiceAvailability({ runtime: 'starting', transport: 'idle' })).toBe('preparing');
  });

  it('stopped は利用不可（営業時間外の正常な停止）', () => {
    expect(resolveVoiceAvailability({ runtime: 'stopped', transport: 'idle' })).toBe('unavailable');
  });

  it('degraded は利用不可（instance crash / health check 失敗）', () => {
    expect(resolveVoiceAvailability({ runtime: 'degraded', transport: 'idle' })).toBe('unavailable');
  });

  it('unknown は fail-safe で利用不可（状態を知らないまま「使えます」と言わない）', () => {
    // 状態 API に到達できない・応答が壊れている等。ここを preparing にすると、永久に
    // 準備中と表示し続けて来訪者を待たせる。unavailable にしてタッチへ寄せる。
    expect(resolveVoiceAvailability({ runtime: 'unknown', transport: 'idle' })).toBe('unavailable');
  });
});

describe('resolveVoiceAvailability — 接続側の状態が優先して落とす', () => {
  it('基盤が ready でも接続を使い果たしていれば提示しない', () => {
    // lifecycle の degraded = 再接続の試行が尽きた。基盤が健全でも端末から届かない。
    expect(resolveVoiceAvailability({ runtime: 'ready', transport: 'degraded' })).toBe('unavailable');
  });

  it('基盤が starting でも接続を使い果たしていれば「準備中」ではなく利用不可', () => {
    expect(resolveVoiceAvailability({ runtime: 'starting', transport: 'degraded' })).toBe(
      'unavailable',
    );
  });

  it('degraded 以外の接続状態は基盤の判定を覆さない', () => {
    const states: VoiceTransportLifecycleState[] = [
      'idle',
      'connecting',
      'connected',
      'reconnecting',
      'closed',
    ];
    for (const transport of states) {
      expect(resolveVoiceAvailability({ runtime: 'ready', transport }), transport).toBe('available');
    }
  });
});

describe('resolveVoiceAvailability — 全状態に判定がある', () => {
  it('どの runtime 状態でも未定義を返さない', () => {
    for (const runtime of REALTIME_RUNTIME_STATUSES) {
      const result = resolveVoiceAvailability({ runtime, transport: 'idle' });
      expect(['available', 'preparing', 'unavailable'], runtime).toContain(result);
    }
  });

  it('transport 未指定（まだ接続を試みていない）でも判定できる', () => {
    expect(resolveVoiceAvailability({ runtime: 'ready' })).toBe('available');
    expect(resolveVoiceAvailability({ runtime: 'starting' })).toBe('preparing');
  });
});

describe('isVoicePresentable — 音声を提示してよい唯一の条件', () => {
  it('available のときだけ true', () => {
    expect(isVoicePresentable('available')).toBe(true);
    expect(isVoicePresentable('preparing')).toBe(false);
    expect(isVoicePresentable('unavailable')).toBe(false);
  });

  it('preparing を「使える」と誤って扱わない（ADR-005 の要求そのもの）', () => {
    const availability = resolveVoiceAvailability({ runtime: 'starting' });
    expect(isVoicePresentable(availability)).toBe(false);
  });
});

describe('タッチ受付は基盤の状態に関わらず必ず使える', () => {
  it('どの runtime 状態でもタッチのフォールバックは残る', () => {
    // サイネージ・タッチ・QR は WebStack 側で独立して動く（ADR-005）。音声が使えないことは
    // 受付が止まることを意味しない。ここは「音声の可否」しか決めない、という契約の確認。
    for (const runtime of REALTIME_RUNTIME_STATUSES) {
      const availability = resolveVoiceAvailability({ runtime });
      expect(availability, runtime).not.toBe(undefined);
    }
  });
});

describe('REALTIME_RUNTIME_STATUSES', () => {
  it('demo harness が模擬する runtime 状態を包含する', () => {
    // demo-studio の DEMO_RUNTIME_STATES（ready/starting/stopped/degraded）をシナリオから
    // そのまま流し込めること。unknown は実運用の「状態 API に到達できない」用で demo には無い。
    const demoStates: RealtimeRuntimeStatus[] = ['ready', 'starting', 'stopped', 'degraded'];
    for (const s of demoStates) expect(REALTIME_RUNTIME_STATUSES).toContain(s);
  });
});
