/**
 * STT (Speech-to-Text) ドメイン契約 (issue #370)。
 *
 * 位置づけ: `StreamingSttProvider` / `SttSession` は issue #370 本文の契約案をそのまま採用する。
 * Amazon Transcribe Streaming 等の実プロバイダは `src/lib/voice-stt/` の adapter が担い、
 * ここは純データ型 + プロバイダ非依存のロジック（`stabilizer.ts` / `entity-resolver.ts` /
 * `fallback.ts` / `eval-bridge.ts`）だけを持つ。
 *
 * Transport との関係（issue #369）: 音声チャンクの物理フォーマットは
 * `src/domain/voice-transport/types.ts` の `VoiceTransportAudioConfig` をそのまま再利用する。
 * ただし実装上の直接依存は型 import のみに留め、`VoiceTransportClient` のクラス実装には
 * 依存しない — STT session の close は `src/lib/voice-stt/close-hook.ts` が構造的型付けで
 * `registerCloseHook` を持つ任意のオブジェクトへ登録できるようにし、Transport 側の実装詳細を
 * 引きずらない。
 */
import type { VoiceTransportAudioConfig } from '@/domain/voice-transport/types';

/** MVP は日本語のみ（issue #370 表題）。 */
export type SttLocale = 'ja-JP';

/**
 * カスタム語彙（担当者名・部門名などドメイン固有語）の PII 方針。
 *
 * - カスタム語彙リストは Amazon Transcribe へアップロードされ AWS 側に保持される。
 *   来訪者の個人情報（氏名・会社名・訪問理由などその場で入力される情報）を語彙へ含めない。
 * - 語彙に含めてよいのは、組織が管理する **既知の静的辞書**（担当者の表示名・よみ・別名、
 *   部門名）だけであり、これは `src/domain/staff` / `src/domain/department` の既存データが
 *   ソースになる。来訪者ごとに動的生成される値（QR トークン・予約者名の自由入力）は含めない。
 * - 語彙 ID（`customVocabularyId`）だけをセッション設定として持ち、語彙の中身（PII を含みうる
 *   固有名詞リスト）はこのモジュールにもイベントにも含めない。監査ログ・評価ハーネスの
 *   イベントへ語彙内容を書き出さないこと（`.claude/rules/pii-secret-minimization.md`）。
 */
export type SttSessionConfig = {
  locale: SttLocale;
  audio: VoiceTransportAudioConfig;
  /** カスタム語彙 ID（上記 PII 方針を参照。値そのものはここに含めない）。 */
  customVocabularyId?: string;
  /** partial results stabilization の初期設定（`stabilizer.ts` の既定値を上書きする場合に使う）。 */
  stabilizer?: Partial<SttStabilizerConfig>;
};

/** STT が返す確信度。0..1。Entity confidence とは別軸で保持する（issue #370 要件）。 */
export type SttConfidence = number;

/**
 * partial 結果。`stable: false` は内部の先読み（不安定）、`stable: true` は
 * UI 字幕へ表示してよい安定化済みテキストを表す（issue #370 AC）。
 */
export type PartialTranscript = {
  text: string;
  stable: boolean;
  confidence: SttConfidence;
  /** セッション開始からの相対 ms（#365 の単一時計源と揃える）。 */
  t: number;
};

export type FinalTranscript = {
  text: string;
  confidence: SttConfidence;
  t: number;
};

/** issue #370 契約案どおりの session interface。 */
export interface SttSession {
  pushAudio(chunk: ArrayBuffer): Promise<void>;
  onPartial(listener: (result: PartialTranscript) => void): void;
  onFinal(listener: (result: FinalTranscript) => void): void;
  close(): Promise<void>;
}

/** issue #370 契約案どおりの provider interface。 */
export interface StreamingSttProvider {
  start(config: SttSessionConfig): Promise<SttSession>;
}

/** partial 安定化の設定（`stabilizer.ts` 参照）。ここに型だけ置き、実装はそちらに閉じる。 */
export type SttStabilizerConfig = {
  /** 安定判定に使う直近 raw partial の件数。 */
  stabilityWindow: number;
  /** stable partial 再表示の最小間隔 ms（ちらつき抑制）。 */
  minEmitIntervalMs: number;
  /** 安定とみなす最小文字数（極端に短い接頭辞でのちらつきを防ぐ）。 */
  minStableChars: number;
};
