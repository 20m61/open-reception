/**
 * Amazon Transcribe Streaming の event stream レスポンス形（抜粋）を、STT ドメイン型
 * (`PartialTranscript` / `FinalTranscript`) へ写像する純関数群 (issue #370)。
 *
 * 位置づけ: これは「接続プロトコル境界まで」の実装であり、実 WSS 接続・SigV4 署名・
 * 実際の AWS 認証情報を要するコネクション確立は #65（実 AWS 認証情報が要る）へスタックする。
 * `transcribe-adapter.ts` はここで定義した型・写像関数と `TranscribeConnection` interface
 * （mock 可能な境界）だけに依存し、接続そのものはテスト用 mock で完結させる。
 *
 * 型は AWS SDK の `TranscribeStreamingClient` イベント形の必要最小部分だけを抜粋している
 * （full type は `@aws-sdk/client-transcribe-streaming` 導入時に差し替え可能、#105 のライセンス
 * チェックは依存追加時に別途行う）。
 */
import type { FinalTranscript, PartialTranscript } from '@/domain/voice-stt/types';

export type TranscribeItem = {
  Content: string;
  /** Transcribe の Item 単位の確信度（0..1）。返らない構成もあるため optional。 */
  Confidence?: number;
  /** partial results stabilization が確定させた語には true が付く。 */
  Stable?: boolean;
};

export type TranscribeAlternative = {
  Transcript: string;
  Items?: TranscribeItem[];
};

export type TranscribeResult = {
  ResultId: string;
  IsPartial: boolean;
  Alternatives: TranscribeAlternative[];
};

export type TranscribeTranscriptEvent = {
  Transcript: { Results: TranscribeResult[] };
};

/** Confidence が無い Item を除いた平均。全 Item に無ければ保守的な既定値 0.5。 */
function averageConfidence(items: readonly TranscribeItem[]): number {
  const withConfidence = items.filter((item) => typeof item.Confidence === 'number');
  if (withConfidence.length === 0) return 0.5;
  const sum = withConfidence.reduce((acc, item) => acc + (item.Confidence ?? 0), 0);
  return sum / withConfidence.length;
}

/**
 * イベント中の最初の partial 結果を `PartialTranscript` へ写像する。無ければ null。
 * `stable` は全 Item が `Stable: true` のときのみ true（1 件でも未確定語があれば false）。
 * Item が 1 つも無い場合（Items 未提供の構成）は保守的に `stable: false` とする。
 */
export function mapTranscribeEventToPartial(event: TranscribeTranscriptEvent, tMs: number): PartialTranscript | null {
  const result = event.Transcript.Results.find((r) => r.IsPartial);
  if (!result) return null;
  const alternative = result.Alternatives[0];
  if (!alternative) return null;

  const items = alternative.Items ?? [];
  const stable = items.length > 0 && items.every((item) => item.Stable === true);
  return { text: alternative.Transcript, stable, confidence: averageConfidence(items), t: tMs };
}

/** イベント中の最初の非 partial（final）結果を `FinalTranscript` へ写像する。無ければ null。 */
export function mapTranscribeEventToFinal(event: TranscribeTranscriptEvent, tMs: number): FinalTranscript | null {
  const result = event.Transcript.Results.find((r) => !r.IsPartial);
  if (!result) return null;
  const alternative = result.Alternatives[0];
  if (!alternative) return null;

  const items = alternative.Items ?? [];
  return { text: alternative.Transcript, confidence: averageConfidence(items), t: tMs };
}
