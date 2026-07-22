/**
 * `VoiceSessionOrchestrator` — 1 受付セッションの音声対話ループを駆動する統合層
 * (issue #364 epic の統合部。#369 Transport + #370 STT + #371 TTS + #372 Turn/barge-in を合成)。
 *
 * 位置づけ: 各層は #369〜#372 で個別に mock 先行実装済み（interface + mock、実 AWS/実機は #65）。
 * このクラスは各層を **直接 new せず**、コンストラクタで受け取った config/providers から
 * 各層のクライアント（`VoiceTransportClient`/`TtsPlaybackControllerImpl`/`TtsSynthesisService`）
 * を組み立て、ドメイン純関数（turn-detector/barge-in-controller）を駆動する glue に徹する
 * ——ビジネスロジック（応答文の決定・受付状態機械）は持たない。呼び出し側（次周回の kiosk 配線 /
 * 受付ロジック）が `onTurnCommitted` を受けて `speak()` を呼ぶ、という分離を保つ。
 *
 * フロー（issue #364 全体パイプラインの mock 版）:
 * ```text
 * pushMicChunk           → Transport(#369) 送出 + STT(#370) session へ供給
 * STT partial/final      → #365 計測イベントへ橋渡し（このクラスが購読して転送）
 * reportSpeechStarted/Ended/SilenceTick → Turn(#372) 状態機械を進める → committed で
 *                           onTurnCommitted（上位への発話確定イベント）
 * speak()                → TTS(#371) 合成 + 再生キュー投入（suppression(#371) を一元チェック）
 * reportNearEndOnset/Update → barge-in(#372) reducer → duck/resume/stop_and_discard を
 *                           TtsPlaybackController(#371) へ反映（TtsBargeInPort 経由）
 * ```
 *
 * フォールバックの正規化（issue #364 統合の完了条件「音声基盤停止時もタッチ受付を完走できる」）:
 * どの層の障害も `src/domain/voice-session/fallback.ts` の `normalize*Fallback` を通り、
 * `onFallback` へは常に同じ形 (`VoiceSessionFallbackEvent`) で届く。
 *
 * close の冪等性: `close()` は `this.closed` を最初に立てたうえで `VoiceTransportClient.close()`
 * のみを呼ぶ —— #369 の `registerCloseHook`（`this.transport` に STT session の close(#370) と
 * TTS 再生停止(#371) を登録済み）が、二重 close でも各 hook を確実に 1 回だけ走らせる
 * （`VoiceTransportClient.terminate()` の `closed` ガード）。二重の保険として本クラス自身も
 * `closed` フラグでガードする。
 */
import { VoiceTransportClient, type VoiceTransportClientConfig } from '@/lib/voice-transport/client';
import { attachSttSessionClose } from '@/lib/voice-stt/close-hook';
import { TtsPlaybackControllerImpl } from '@/lib/voice-tts/playback-controller';
import { TtsSynthesisService, type TtsSynthesizeOptions, type TtsSynthesisResult } from '@/lib/voice-tts/synthesis-service';

import type { StreamingSttProvider, SttSession, SttSessionConfig } from '@/domain/voice-stt/types';
import type { VoiceSttFallbackEvent } from '@/domain/voice-stt/fallback';
import { sttPartialEvent, sttFinalEvent } from '@/domain/voice-stt/eval-bridge';

import type { StreamingTtsProvider, TtsCache, TtsRequest } from '@/domain/voice-tts/types';
import { shouldSuppressCharacterTts, type TtsSuppressionInput } from '@/domain/voice-tts/suppression';

import {
  advanceTurnDetector,
  initialTurnDetectorState,
  DEFAULT_TURN_DETECTOR_CONFIG,
  type TurnDetectorConfig,
  type TurnDetectorState,
  type TurnDetectorTick,
} from '@/domain/voice-turn/turn-detector';
import {
  onNearEndOnset,
  onNearEndUpdate,
  applyBargeInAction,
  initialBargeInControllerState,
  type BargeInAction,
  type BargeInControllerState,
  type TtsBargeInPort,
} from '@/domain/voice-turn/barge-in-controller';
import { DEFAULT_NEAR_END_CLASSIFIER_CONFIG, type NearEndClassifierConfig, type NearEndSignal } from '@/domain/voice-turn/near-end-classifier';
import type { TurnSlot } from '@/domain/voice-turn/types';
import { speechEndEvent, turnCommittedEvent, audioOnsetEvent, type VoiceTurnErrorCode } from '@/domain/voice-turn/eval-bridge';

import {
  normalizeTransportFallback,
  normalizeSttFallback,
  normalizeTtsFallback,
  normalizeTurnFallback,
} from '@/domain/voice-session/fallback';
import type { VoiceSessionFallbackEvent, VoiceSessionVrmState } from '@/domain/voice-session/types';

import type { VoiceEvalEvent, VoiceEvalTurnTrigger } from '@/domain/voice/evaluation-events';

export type VoiceSessionConfig = {
  transport: VoiceTransportClientConfig;
  stt: SttSessionConfig;
  turn?: Partial<TurnDetectorConfig>;
  nearEnd?: Partial<NearEndClassifierConfig>;
};

/** 各層の provider を DI で受け取る（直接 new しない）。mock/実装のどちらでも差し込める。 */
export type VoiceSessionProviders = {
  sttProvider: StreamingSttProvider;
  ttsProvider: StreamingTtsProvider;
  ttsCache: TtsCache;
};

export type VoiceSessionCallbacks = {
  /** テスト用の時計注入。省略時は Date.now()。 */
  now?: () => number;
  onFallback?: (event: VoiceSessionFallbackEvent) => void;
  onEvalEvent?: (event: VoiceEvalEvent) => void;
  /** ターン確定（上位＝受付ロジックへの発話確定イベント）。応答の決定は呼び出し側の責務。 */
  onTurnCommitted?: (text: string, trigger: VoiceEvalTurnTrigger) => void;
  /** TTS 再生状態と同期した VRM 遷移（`TtsPlaybackControllerImpl` の speaking 通知を写像）。 */
  onVrmStateChange?: (state: VoiceSessionVrmState) => void;
};

export type VoiceSessionSpeakResult = TtsSynthesisResult | { outcome: 'suppressed' };

export class VoiceSessionOrchestrator {
  private readonly transport: VoiceTransportClient;
  private readonly ttsController: TtsPlaybackControllerImpl;
  private readonly ttsSynthesis: TtsSynthesisService;
  private readonly turnConfig: TurnDetectorConfig;
  private readonly nearEndConfig: NearEndClassifierConfig;
  /** `TtsBargeInPort` アダプタ。`stopPlayback` にだけ `reason: 'barge_in'` を固定で渡す
   *  （#372 reducer の `stop_and_discard` は常に barge-in 由来であるため）。 */
  private readonly bargeInPort: TtsBargeInPort;

  private sttSession: SttSession | null = null;
  private turnState: TurnDetectorState = initialTurnDetectorState();
  private bargeInState: BargeInControllerState = initialBargeInControllerState();
  private activeUtteranceId: string | null = null;
  private suppression: TtsSuppressionInput = { callConnected: false, liveBridgeActive: false };
  private started = false;
  private closed = false;

  constructor(
    private readonly config: VoiceSessionConfig,
    private readonly providers: VoiceSessionProviders,
    private readonly callbacks: VoiceSessionCallbacks = {},
  ) {
    this.turnConfig = { ...DEFAULT_TURN_DETECTOR_CONFIG, ...config.turn };
    this.nearEndConfig = { ...DEFAULT_NEAR_END_CLASSIFIER_CONFIG, ...config.nearEnd };

    this.transport = new VoiceTransportClient(config.transport, {
      onFallback: (event) => this.emitFallback(normalizeTransportFallback(event)),
      onEvalEvent: (event) => this.emitEval(event),
    });

    this.ttsController = new TtsPlaybackControllerImpl({
      now: () => this.now(),
      onSpeakingChanged: (event) => this.callbacks.onVrmStateChange?.(event.speaking ? 'speaking' : 'listening'),
      onEvalEvent: (event) => this.emitEval(event),
    });

    this.ttsSynthesis = new TtsSynthesisService(providers.ttsProvider, providers.ttsCache, {
      now: () => this.now(),
      // `tts.playback_start` は TtsSynthesisService（合成完了時点）と TtsPlaybackControllerImpl
      // （実際に再生キューが playing になった時点）の両方が出しうる —— この orchestrator では
      // 後者だけを単一の発生源とする（合成完了 = 再生開始ではないため、二重発火を防ぐ）。
      onEvalEvent: (event) => {
        if (event.type === 'tts.playback_start') return;
        this.emitEval(event);
      },
    });

    this.bargeInPort = {
      duck: (utteranceId) => this.ttsController.duck(utteranceId),
      resume: (utteranceId) => this.ttsController.resume(utteranceId),
      stopPlayback: (utteranceId) => this.ttsController.stopPlayback(utteranceId, 'barge_in'),
      discardQueuedAudio: (utteranceId) => this.ttsController.discardQueuedAudio(utteranceId),
    };
  }

  private now(): number {
    return this.callbacks.now?.() ?? Date.now();
  }

  private emitEval(event: VoiceEvalEvent): void {
    this.callbacks.onEvalEvent?.(event);
  }

  private emitFallback(event: VoiceSessionFallbackEvent): void {
    this.callbacks.onFallback?.(event);
  }

  /**
   * Transport(#369) 接続を開始し、STT(#370) session を確立する。STT session の close を
   * Transport の close hook へ登録する（`attachSttSessionClose`、#369/#370 の既存の橋渡しをそのまま
   * 再利用）。TTS(#371) の停止も close hook として登録する。冪等 — 二重呼び出しは無視する。
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.transport.connect();

    const session = await this.providers.sttProvider.start(this.config.stt);
    this.sttSession = session;
    attachSttSessionClose(this.transport, session);
    this.transport.registerCloseHook(() => this.stopAllTtsPlayback());

    session.onPartial((partial) => this.emitEval(sttPartialEvent(partial)));
    session.onFinal((final) => this.emitEval(sttFinalEvent(final)));
  }

  /**
   * マイクチャンクを供給する。Transport(#369) へ送出しつつ、この mock 統合では同じチャンクを
   * STT(#370) session へも渡す（実運用ではサーバ側で Transport → STT が中継されるが、interface +
   * mock の範囲ではローカルの STT provider を直接駆動する）。
   */
  pushMicChunk(bytes: ArrayBuffer): void {
    if (this.closed) return;
    this.transport.sendAudioChunk(bytes);
    void this.sttSession?.pushAudio(bytes);
  }

  // --- Turn(#372): ユーザー発話の観測 → ターン確定 ---

  reportSpeechStarted(): void {
    if (this.closed) return;
    this.emitEval(audioOnsetEvent(this.now()));
    this.advanceTurn({ type: 'speech-started' });
  }

  reportSpeechEnded(text: string): void {
    if (this.closed) return;
    this.emitEval(speechEndEvent(this.now()));
    this.advanceTurn({ type: 'speech-ended', text });
  }

  reportSilenceTick(silenceMs: number, slot?: TurnSlot): void {
    if (this.closed) return;
    this.advanceTurn({ type: 'silence-tick', silenceMs, slot });
  }

  /** ターンが確定して以降、次の発話を受け付けるために状態機械をリセットする（呼び出し側が明示する）。 */
  resetTurn(): void {
    this.turnState = initialTurnDetectorState();
  }

  private advanceTurn(tick: TurnDetectorTick): void {
    const { state, emitted } = advanceTurnDetector(this.turnState, tick, this.turnConfig);
    this.turnState = state;
    for (const event of emitted) {
      if (event.type === 'committed') {
        this.emitEval(turnCommittedEvent(this.now(), this.turnState.text, event.trigger));
        this.callbacks.onTurnCommitted?.(this.turnState.text, event.trigger);
      }
    }
  }

  // --- TTS(#371): 発話 + suppression の一元化 ---

  /**
   * 通話接続中/live_bridge 中のキャラクター TTS 抑止（#371 設計方針）を更新する。抑止が有効化
   * された時点で再生中の utterance があれば直ちに停止・破棄する（barge-in の
   * `stop_and_discard` と同じ効果を、通話接続という別要因からも一元的に適用する — issue #364
   * 統合スコープ「connected/live_bridge 中の TTS 抑止と barge-in の共存規則を統合層で一元化」）。
   */
  updateTtsSuppression(input: TtsSuppressionInput): void {
    this.suppression = input;
    if (shouldSuppressCharacterTts(input) && this.activeUtteranceId) {
      const id = this.activeUtteranceId;
      this.ttsController.stopPlayback(id, 'cancelled');
      this.ttsController.discardQueuedAudio(id);
      this.activeUtteranceId = null;
      this.bargeInState = initialBargeInControllerState();
    }
  }

  /**
   * TTS(#371) で応答を合成・再生する。suppression が有効な間は合成すら行わず `suppressed` を
   * 返す（通話中にキャラクターが喋り出さないことを構造的に保証する）。
   */
  async speak(request: TtsRequest, options?: TtsSynthesizeOptions): Promise<VoiceSessionSpeakResult> {
    if (this.closed) return { outcome: 'suppressed' };
    if (shouldSuppressCharacterTts(this.suppression)) return { outcome: 'suppressed' };

    const result = await this.ttsSynthesis.synthesize(request, options);
    this.handleTtsOutcome(result);

    if (result.outcome === 'cached' || result.outcome === 'generated' || result.outcome === 'fallback_cached') {
      this.ttsController.enqueue({ utteranceId: request.utteranceId, seq: 0, audioTimestampMs: 0, byteLength: 0, final: true });
      this.ttsController.startPlayback(request.utteranceId);
      this.activeUtteranceId = request.utteranceId;
    }
    return result;
  }

  /** 障害由来の outcome を #364 統合フォールバックへ正規化する（`fallback_caption` は継続可能だが監視上は報告する）。 */
  private handleTtsOutcome(result: TtsSynthesisResult): void {
    if (result.outcome === 'fallback_cached' || result.outcome === 'fallback_caption') {
      this.emitFallback(normalizeTtsFallback(result.reason, this.now()));
    }
  }

  /** アクティブな utterance が barge-in で止められることなく最後まで再生し終えた。 */
  completeActiveUtterance(): void {
    if (!this.activeUtteranceId) return;
    this.ttsController.completePlayback(this.activeUtteranceId);
    this.activeUtteranceId = null;
  }

  isSpeaking(): boolean {
    return this.activeUtteranceId !== null && this.ttsController.isPlaying(this.activeUtteranceId);
  }

  // --- barge-in(#372): TTS 再生中のユーザー発話の観測 → duck/resume/stop ---

  reportNearEndOnset(): void {
    if (this.closed || !this.activeUtteranceId) return;
    this.emitEval(audioOnsetEvent(this.now()));
    const { state, action } = onNearEndOnset(this.bargeInState, this.activeUtteranceId);
    this.bargeInState = state;
    this.applyBargeIn(action);
  }

  reportNearEndUpdate(signal: NearEndSignal): void {
    if (this.closed || !this.activeUtteranceId) return;
    const { state, action } = onNearEndUpdate(this.bargeInState, signal, this.nearEndConfig);
    this.bargeInState = state;
    this.applyBargeIn(action);
  }

  /** `BargeInAction`（#372 reducer の出力）をそのまま `TtsBargeInPort` へ適用する（使い分けの唯一の分岐点）。 */
  private applyBargeIn(action: BargeInAction): void {
    applyBargeInAction(action, this.bargeInPort);
    if (action.type === 'stop_and_discard') {
      this.activeUtteranceId = null;
    }
  }

  // --- 障害の手動報告（実 adapter の onFallback 等からの入口、issue #364 統合） ---

  /**
   * STT(#370) 層の障害を報告する。mock provider 自体は fallback を持たないため、実 adapter
   * （`TranscribeStreamingSttProvider` の `onFallback`）や呼び出し側の stall watchdog が
   * ここへ橋渡しする想定の入口。
   */
  reportSttFallback(event: VoiceSttFallbackEvent): void {
    this.emitFallback(normalizeSttFallback(event));
  }

  /** Turn/barge-in(#372) 層の障害（VAD 不能・duck/stop 失敗等）を報告する。 */
  reportTurnFallback(code: VoiceTurnErrorCode, t: number = this.now()): void {
    this.emitFallback(normalizeTurnFallback(code, t));
  }

  // --- close(冪等、#369 registerCloseHook 経由で #370/#371 も含めた全層を確実に close) ---

  /** アクティブ/キュー中の TTS 再生を止める（close hook として #369 に登録される）。 */
  private stopAllTtsPlayback(): void {
    if (this.activeUtteranceId) {
      this.ttsController.stopPlayback(this.activeUtteranceId, 'cancelled');
      this.activeUtteranceId = null;
    }
    for (const utteranceId of this.ttsController.pendingUtteranceIds()) {
      this.ttsController.discardQueuedAudio(utteranceId);
    }
  }

  /** セッションを終了する。冪等 — 二重に呼んでも close hook（STT close・TTS 停止）は 1 回しか走らない。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
  }
}
