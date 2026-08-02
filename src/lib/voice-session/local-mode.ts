import { createOrchestratorVoiceSession, type VoiceSessionFactory } from './kiosk-binding';
import { VoiceSessionOrchestrator } from './orchestrator';
import { createMockSttProvider } from '@/lib/voice-stt/mock-provider';
import { MockStreamingTtsProvider } from '@/lib/voice-tts/mock-provider';
import { InMemoryTtsCache } from '@/lib/voice-tts/cache-store';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import type { VoiceTransportSocket, VoiceTransportSocketFactory } from '@/lib/voice-transport/socket';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';

/**
 * 実 orchestrator を **mock provider 駆動**でローカル起動するための組み立て (#372 配線)。
 *
 * ## なぜ要るか
 *
 * `VoiceSessionOrchestrator`（ターン検出・barge-in・TTS duck/stop・VRM 同期）は実装も
 * unit テストも揃っているのに、**本番呼び出し元がゼロ**だった。`reportNearEndOnset` /
 * `reportNearEndUpdate` を呼ぶ本番コードが無く、`createOrchestratorVoiceSession` も
 * 誰も使っていない ── つまり**作ってあるが一度も起動しない**状態。
 *
 * 実音声（マイク → transport → Transcribe）は #369/#370 の本体で実 AWS・実機が要る。
 * その前に、**mock provider で実 orchestrator を通す経路**を作っておくと、ターン検出と
 * barge-in の挙動を実 UI と e2e で確かめられる。
 *
 * ## 既定では使わない
 *
 * 受付端末の音声挙動を変えるので、`?voiceOrchestrator=1` を付けた端末だけが使う
 * （`shouldUseLocalVoiceOrchestrator`）。テナント設定にもスキーマにも触らない ──
 * 既定 ON になるフラグ機構（`TENANT_FEATURE_FLAG_KEYS`）は、この用途には使えない。
 */

/**
 * ループバック socket。**ネットワークへ出ない。**
 *
 * transport は本来 WebSocket を張るが、ローカル検証で必要なのは「開いていて、送っても
 * 落ちない」ことだけ。実サーバを立てると #369 の実装を先取りすることになるので、
 * ここでは接続を成立させるだけの最小実装にする。
 */
function createLoopbackSocketFactory(): VoiceTransportSocketFactory {
  return () => {
    const socket: VoiceTransportSocket = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: () => {
        /* 送信先は無い。落とすだけ（ローカル検証では上りの音声は使わない）。 */
      },
      close: (code = 1000, reason = 'local mode') => {
        socket.onclose?.({ code, reason });
      },
    };
    // 次のマイクロタスクで開通を通知する（同期で呼ぶと購読前に発火して取りこぼす）。
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
}

/**
 * この端末でローカル orchestrator を使うか。
 *
 * **既定は false。** 付けた端末だけが対象で、他の端末・他のテナントには影響しない。
 */
export function shouldUseLocalVoiceOrchestrator(search: string): boolean {
  return new URLSearchParams(search).get('voiceOrchestrator') === '1';
}

/**
 * mock provider 駆動の `VoiceSessionFactory` を作る。
 *
 * `phrases` は認識候補（在席担当者名など）。mock STT はこの中から確定文を返すので、
 * 画面に居る担当者を渡すこと（渡さないと解決できない候補ばかりになる）。
 */
export function createLocalVoiceSessionFactory(
  directory: EntityDirectory,
  phrases: readonly string[],
): VoiceSessionFactory {
  const spoken = phrases[0] ?? '';
  return createOrchestratorVoiceSession(
    (callbacks) =>
      driveWithSyntheticAudio(
        new VoiceSessionOrchestrator(
        {
          transport: {
            url: 'loopback://voice',
            socketFactory: createLoopbackSocketFactory(),
            queueLimits: { maxChunks: 64, maxBytes: 1024 * 1024, dropPolicy: 'drop-oldest' },
            rateLimit: { capacity: 64, refillPerMs: 1 },
            heartbeatIntervalMs: 30_000,
            heartbeatTimeoutMs: 60_000,
            idleTimeoutMs: 300_000,
            // ローカルは再接続しない（loopback なので落ちる要因が無い）。
            reconnect: { backoff: { baseMs: 1000, maxMs: 1000 }, maxAttempts: 0 },
          },
          stt: { locale: 'ja-JP', audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG },
        },
        {
          sttProvider: createMockSttProvider({
            partials: spoken === '' ? [] : [{ afterChunk: 1, text: spoken, confidence: 0.9 }],
            final: { afterChunk: 2, text: spoken, confidence: 0.95 },
          }),
          ttsProvider: new MockStreamingTtsProvider(),
          ttsCache: new InMemoryTtsCache(),
        },
          callbacks,
        ),
        spoken,
      ),
    { directory, now: () => Date.now() },
  );
}

/**
 * 合成音声で実 orchestrator を駆動する。
 *
 * ## なぜ要るか
 *
 * orchestrator は `pushMicChunk` / `reportSpeechStarted` / `reportSilenceTick` を
 * **外部から駆動される**設計で、seam（`VoiceSessionController`）はそれを露出しない。
 * 実機ではマイクと VAD が駆動するが、ローカルにはそれが無い。駆動側を用意しないと
 * 「起動はするが何も起きない」セッションになる ── まさにそれが今までの状態だった。
 *
 * ここでは start 後に短い発話シーケンスを 1 回流す。ターン検出（無音 → 確定）が実際に走り、
 * 上位（Kiosk UI）へ確定テキストが届くところまでを実 UI で確かめられる。
 *
 * **本番の音声挙動ではない。** `?voiceOrchestrator=1` を付けた端末だけが通る検証用の駆動。
 */
function driveWithSyntheticAudio(
  orchestrator: VoiceSessionOrchestrator,
  spoken: string,
): VoiceSessionOrchestrator {
  const originalStart = orchestrator.start.bind(orchestrator);
  orchestrator.start = async () => {
    await originalStart();
    if (spoken === '') return;
    orchestrator.reportSpeechStarted();
    // mock STT は「何チャンク目で partial / final を出すか」で駆動する。
    for (let i = 0; i < 3; i += 1) orchestrator.pushMicChunk(new ArrayBuffer(320));
    orchestrator.reportSpeechEnded(spoken);
    // 無音の蓄積でターンを確定させる（固定無音だけを真実源にしない設計だが、
    // 合成では上限を超える値を 1 度入れて確定まで進める）。
    orchestrator.reportSilenceTick(2_000);
  };
  return orchestrator;
}
