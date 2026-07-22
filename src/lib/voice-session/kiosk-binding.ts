/**
 * Kiosk への音声セッション注入 seam (issue #364 kiosk 配線)。
 *
 * `VoiceSessionFactory` は Kiosk（`KioskFlow`）へ渡す opt-in の注入 prop。未指定なら Kiosk は
 * 従来どおりタッチ専用で動作する（完全な無変更動作）。指定時のみ音声対話 UI（字幕・復唱確認・
 * barge-in インジケータ）が有効化される。
 *
 * ここでは 2 種類の factory を提供する:
 *  - `createSyntheticVoiceSession`: 実 orchestrator/実機なしで発話・復唱・barge-in・障害を合成駆動する
 *    mock。**demo-studio のシナリオ再現とテストの固定**に使う（直接シングルトン化せず factory で公開）。
 *  - `createOrchestratorVoiceSession`: 実 `VoiceSessionOrchestrator` を束ね、そのコールバックを Kiosk UI
 *    イベントへ写像する。orchestrator の構築（config/providers）は呼び出し側（Kiosk/demo-studio）が
 *    `construct` クロージャで与えるため、本モジュールは重い依存を直接 new しない。
 *
 * PII 方針: emit するイベント（`VoiceKioskEvent`）は表示用の意味論値のみ。`displayName` は組織が管理する
 * 担当者/部門辞書由来で、来訪者の自由入力ではない。監査ログ・評価イベントへは何も書き出さない
 * （`.claude/rules/pii-secret-minimization.md`）。
 */
import {
  bridgeCommittedTurn,
  type BridgeCommittedTurnResult,
} from '@/domain/voice-session/kiosk-bridge';
import type { VoiceKioskEvent } from '@/domain/voice-session/kiosk-view';
import type { VoiceSessionFallbackSource } from '@/domain/voice-session/types';
import type {
  EntityDirectory,
  EntityCandidate,
  EntityResolutionThresholds,
} from '@/domain/voice-stt/entity-resolver';
import type { VoiceSessionCallbacks } from './orchestrator';

/** UI 状態機械へイベントを流し込む口。 */
export type VoiceKioskEmit = (event: VoiceKioskEvent) => void;

/**
 * Kiosk が保持し、タッチ/音声いずれの操作からも呼べる音声セッション操作。
 * `confirmYes`/`confirmNo` は復唱確認の確定/否定（タッチボタンでも音声「はい/いいえ」でも同じ入口）。
 */
export interface VoiceSessionController {
  start(): void | Promise<void>;
  close(): void | Promise<void>;
  confirmYes(): void;
  confirmNo(): void;
}

/** Kiosk へ渡す注入 prop。emit を受け取り、駆動可能な controller を返す。 */
export type VoiceSessionFactory = (emit: VoiceKioskEmit) => VoiceSessionController;

/** 解決済み候補を既存選択へ橋渡しするコールバック（Kiosk が selection を進める）。 */
export type OnResolved = (candidate: EntityCandidate | null) => void;

export type VoiceSessionBridgeDeps = {
  /** マッチング対象の担当者/部門辞書。 */
  directory: EntityDirectory;
  /** 発話の STT confidence。関数で text→confidence を返せる（mock は固定でよい）。既定 0.9。 */
  sttConfidence?: number | ((text: string) => number);
  /** 低信頼判定の閾値（省略時は #370 既定）。 */
  thresholds?: EntityResolutionThresholds;
  /** テスト用時計。既定 Date.now()。 */
  now?: () => number;
  /** 確定時に既存選択へ橋渡しする。 */
  onResolved?: OnResolved;
};

function confidenceFor(source: VoiceSessionBridgeDeps['sttConfidence'], text: string): number {
  if (typeof source === 'function') return source(text);
  return source ?? 0.9;
}

function bridge(deps: VoiceSessionBridgeDeps, text: string): BridgeCommittedTurnResult {
  return bridgeCommittedTurn({
    text,
    directory: deps.directory,
    sttConfidence: confidenceFor(deps.sttConfidence, text),
    thresholds: deps.thresholds,
    t: (deps.now ?? Date.now)(),
  });
}

// =============================================================================
// Synthetic（mock 合成駆動 / demo-studio 再現）
// =============================================================================

export type SyntheticVoiceDriver = {
  /** Kiosk へ渡す factory。 */
  factory: VoiceSessionFactory;
  /** リスニング開始（マイク取り込み開始）を合成する。 */
  beginListening(): void;
  /** 発話が確定した体で Entity 解決へ回す（確定テキストを与える）。 */
  hearTurn(text: string): void;
  /** TTS 発話開始/終了を合成する。 */
  startSpeaking(): void;
  endSpeaking(): void;
  /** TTS 発話中の barge-in（duck）を合成する。 */
  bargeIn(): void;
  /** いずれかの層の障害（タッチ縮退）を合成する。 */
  fail(source: VoiceSessionFallbackSource): void;
};

/**
 * 実 orchestrator/実機なしで音声対話 UI を合成駆動する factory を作る。
 * demo-studio のシナリオ再現・コンポーネント/統合テストの固定に使う。
 */
export function createSyntheticVoiceSession(deps: VoiceSessionBridgeDeps): SyntheticVoiceDriver {
  let emit: VoiceKioskEmit = () => {};
  /** 直近の復唱で保留中の解決済み候補（confirmYes で選択へ渡す）。 */
  let pendingResolved: EntityCandidate | null = null;

  const factory: VoiceSessionFactory = (e) => {
    emit = e;
    return {
      start: () => {},
      close: () => {},
      confirmYes: () => {
        emit({ type: 'confirmYes' });
        deps.onResolved?.(pendingResolved);
        pendingResolved = null;
      },
      confirmNo: () => {
        emit({ type: 'confirmNo' });
        pendingResolved = null;
      },
    };
  };

  return {
    factory,
    beginListening: () => emit({ type: 'listenStart' }),
    hearTurn: (text) => {
      const { event, resolved } = bridge(deps, text);
      if (event.type === 'heardAccepted') {
        emit(event);
        deps.onResolved?.(resolved);
      } else if (event.type === 'heardNeedsConfirmation') {
        pendingResolved = resolved;
        emit(event);
      } else {
        emit(event); // listenStart（聞き直し）
      }
    },
    startSpeaking: () => emit({ type: 'speakStart' }),
    endSpeaking: () => emit({ type: 'speakEnd' }),
    bargeIn: () => emit({ type: 'bargeInDuck' }),
    fail: (source) => emit({ type: 'fallbackRequired', source }),
  };
}

// =============================================================================
// Orchestrator wrapper（実 VoiceSessionOrchestrator を束ねる seam）
// =============================================================================

/**
 * `createOrchestratorVoiceSession` が必要とする orchestrator の最小構造。
 * `VoiceSessionOrchestrator` はこれを構造的に満たす（`start`/`close`/`resetTurn`）。fake で差し替え可能。
 */
export interface VoiceSessionLike {
  start(): Promise<void> | void;
  close(): Promise<void> | void;
  resetTurn(): void;
}

/**
 * 実 orchestrator を束ねて Kiosk UI イベントへ写像する factory を作る。
 *
 * `construct` は与えた `VoiceSessionCallbacks` から orchestrator を生成するクロージャ
 * （例: `(cb) => new VoiceSessionOrchestrator(config, providers, cb)`）。orchestrator の重い依存を
 * 本モジュールへ持ち込まないための注入点。
 *
 * 写像:
 *  - `onTurnCommitted(text)` → Entity 解決（#370）→ heardAccepted / heardNeedsConfirmation / listenStart。
 *  - `onVrmStateChange('speaking'|'listening')` → speakStart / speakEnd。
 *  - `onFallback`（transport/stt/turn 由来）→ fallbackRequired。**tts 由来は継続可能なので UI を縮退させない**
 *    （字幕/キャッシュで受付継続できる #371 設計に従い、診断シグナルとしてのみ扱う）。
 *  - `confirmYes/No` → 確定/否定を emit し、orchestrator の `resetTurn` で次ターンへ備える。
 */
export function createOrchestratorVoiceSession(
  construct: (callbacks: VoiceSessionCallbacks) => VoiceSessionLike,
  deps: VoiceSessionBridgeDeps,
): VoiceSessionFactory {
  return (emit) => {
    let pendingResolved: EntityCandidate | null = null;

    const orchestrator = construct({
      now: deps.now,
      onTurnCommitted: (text) => {
        const { event, resolved } = bridge(deps, text);
        if (event.type === 'heardAccepted') {
          emit(event);
          deps.onResolved?.(resolved);
        } else if (event.type === 'heardNeedsConfirmation') {
          pendingResolved = resolved;
          emit(event);
        } else {
          emit(event);
        }
      },
      onVrmStateChange: (state) => {
        emit(state === 'speaking' ? { type: 'speakStart' } : { type: 'speakEnd' });
      },
      onFallback: (fallback) => {
        // TTS は字幕/キャッシュで継続できるため UI をタッチへ縮退させない（診断のみ）。
        if (fallback.source === 'tts') return;
        emit({ type: 'fallbackRequired', source: fallback.source });
      },
    });

    return {
      start: () => orchestrator.start(),
      close: () => orchestrator.close(),
      confirmYes: () => {
        emit({ type: 'confirmYes' });
        orchestrator.resetTurn();
        deps.onResolved?.(pendingResolved);
        pendingResolved = null;
      },
      confirmNo: () => {
        emit({ type: 'confirmNo' });
        orchestrator.resetTurn();
        pendingResolved = null;
      },
    };
  };
}
