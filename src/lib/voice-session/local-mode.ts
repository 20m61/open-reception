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
 * 発話候補は `directory` そのものから導く。**別引数で受け取らない** ── 受け取ると
 * 「解決できる集合（directory）」と「喋る集合（phrases）」がずれうる。実際、直前の形では
 * directory 側だけ在席で絞って phrases 側を絞り忘れても誰も気づけなかった
 * （不在の担当者名を mock STT が喋り、解決だけ失敗する）。
 *
 * ## 合成発話の起点は `start()` ではなく相手選択への到達 (#788)
 *
 * 🔴 **`start()` で喋らせない。** セッションは (a) マウント時（`data.state === 'idle'`）と
 * (b) factory が作り直されたとき（構成取得の着地など）に start する。そこで喋ると
 * **来訪者が一言も発していないのに相手が確定する**——高信頼・候補 1 件なら
 * `bridgeCommittedTurn` は復唱を挟まず `heardAccepted` を返し、`onResolved` →
 * `SELECT_TARGET` がそのまま通る。実 Directory を渡す前（空辞書）は候補ゼロで無害
 * だったが、渡した途端に実害のある競合になる。
 *
 * 逆に start だけを起点にすると**通常の導線では一度も喋らない**。マウント時点の
 * Directory は空（取得は非同期）なので `spoken` が空、着地後の再 start は `idle` で
 * reducer が握り潰し、受付が始まると構成の再適用が止まって factory は作り直されない。
 *
 * よって demo-studio と同じく `notifyReceptionState('selectingTarget')` を起点にする
 * （`kiosk-injection.ts` が同じ罠を先に潰している）。
 *
 * ## 1 セッション 1 回だけ
 *
 * 相手選択へ**再到達**するたびに喋ると、来訪者が「戻る」で選び直そうとした瞬間に
 * 同じ相手が再確定し、抜けられなくなる。demo-studio は台本を再生する用途なので毎回
 * 再開してよいが、こちらは実受付の導線に乗るので 1 回で止める。
 */
export function createLocalVoiceSessionFactory(directory: EntityDirectory): VoiceSessionFactory {
  const spoken = directory.staff[0]?.displayName ?? '';
  return (emit, hooks) => {
    // `construct` はこの factory 呼び出しの中で同期的に 1 回呼ばれる。その回の
    // orchestrator を掴んで、相手選択へ到達したときだけ合成発話を流す。
    let orchestrator: VoiceSessionOrchestrator | null = null;
    const controller = createOrchestratorVoiceSession(
      (callbacks) => {
        orchestrator = new VoiceSessionOrchestrator(
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
        );
        return orchestrator;
      },
      { directory, now: () => Date.now() },
    )(emit, hooks);

    let spokenAlready = false;
    return {
      ...controller,
      notifyReceptionState: (state) => {
        if (state !== 'selectingTarget' || spoken === '' || spokenAlready) return;
        if (orchestrator === null) return;
        spokenAlready = true;
        driveWithSyntheticAudio(orchestrator, spoken);
      },
    };
  };
}

/**
 * 合成音声で実 orchestrator を 1 ターン駆動する。
 *
 * ## なぜ要るか
 *
 * orchestrator は `pushMicChunk` / `reportSpeechStarted` / `reportSilenceTick` を
 * **外部から駆動される**設計で、seam（`VoiceSessionController`）はそれを露出しない。
 * 実機ではマイクと VAD が駆動するが、ローカルにはそれが無い。駆動側を用意しないと
 * 「起動はするが何も起きない」セッションになる ── まさにそれが今までの状態だった。
 *
 * 🔴 **`start()` を包まない。** 以前は start を上書きして起動と同時に喋らせていたが、
 * それだと来訪者が一言も発していない局面（idle・構成取得の着地）で相手が確定しうる。
 * 起点の判断は呼び出し側（`createLocalVoiceSessionFactory`）が持ち、ここは
 * 「呼ばれたら 1 ターン流す」だけにする。
 *
 * **本番の音声挙動ではない。** `?voiceOrchestrator=1` を付けた端末だけが通る検証用の駆動。
 */
function driveWithSyntheticAudio(orchestrator: VoiceSessionOrchestrator, spoken: string): void {
  if (spoken === '') return;
  orchestrator.reportSpeechStarted();
  // mock STT は「何チャンク目で partial / final を出すか」で駆動する。
  for (let i = 0; i < 3; i += 1) orchestrator.pushMicChunk(new ArrayBuffer(320));
  orchestrator.reportSpeechEnded(spoken);
  // 無音の蓄積でターンを確定させる（固定無音だけを真実源にしない設計だが、
  // 合成では上限を超える値を 1 度入れて確定まで進める）。
  orchestrator.reportSilenceTick(2_000);
}
