/**
 * partial 結果の安定化 (issue #370)。
 *
 * 目的: STT provider（AWS Transcribe 含む）は発話の途中経過を頻繁に書き換えながら返す
 * （"unstable" partial）。UI 字幕にそのまま流すと激しくちらつくため、直近の raw partial 列の
 * **最長共通接頭辞 (LCP)** が一定件数 (`stabilityWindow`) 連続で確認できた時点でのみ
 * "stable partial" として確定し、かつ再表示の最小間隔 (`minEmitIntervalMs`) を空ける
 * （issue #370 AC「partial の書き換わりで画面が過度にちらつかない」）。
 *
 * 設計方針:
 * - 状態は `src/domain/voice-transport/lifecycle.ts` と同じ流儀（純関数 + 明示的な state
 *   オブジェクト）。I/O は持たない。
 * - stable text は後退しない（一度確定した接頭辞を UI から取り消さない）。ただし raw partial が
 *   確定済みテキストと矛盾する場合（AWS が誤り訂正した稀なケース）は、新しい LCP に切り替える
 *   （「常に確定テキストで始まる新しい LCP」を待つのではなく、常に最新の LCP を正とする）。
 * - 実 provider（AWS Transcribe の partial results stabilization）が持つ item 単位の
 *   `Stable` フラグを使わない汎用フォールバックとしても使える。実 Transcribe adapter は
 *   自身の Stable フラグを直接使ってもよいが、UI ちらつき抑制の最終防衛としてこのデバウンスは
 *   常に併用する（`src/lib/voice-stt/` 側で使う想定）。
 */
import type { SttStabilizerConfig } from './types';

export const DEFAULT_STT_STABILIZER_CONFIG: SttStabilizerConfig = {
  stabilityWindow: 2,
  minEmitIntervalMs: 250,
  minStableChars: 2,
};

export type SttStabilizerState = {
  /** 直近の raw partial テキスト（最大 stabilityWindow 件、古い順）。 */
  history: string[];
  /** 内部的に確定している最新の安定テキスト（emit 済みとは限らない = debounce で積み残しうる）。 */
  confirmedText: string;
  /** 直近に emit した安定テキスト。 */
  lastEmittedText: string;
  /** 直近に emit した時刻（ms）。未 emit なら null。 */
  lastEmitAtMs: number | null;
};

export function emptyStabilizerState(): SttStabilizerState {
  return { history: [], confirmedText: '', lastEmittedText: '', lastEmitAtMs: null };
}

export type SttStabilizerResult = {
  state: SttStabilizerState;
  /** 新たに表示すべき stable partial。無ければ null。 */
  stable: string | null;
};

/** 文字列配列の最長共通接頭辞。空配列は空文字。 */
function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === '') return '';
  }
  return prefix;
}

/**
 * 新しい raw partial を取り込み、必要なら stable partial を確定する。
 *
 * 手順:
 * 1. history へ追加し、直近 `stabilityWindow` 件へトリムする。
 * 2. window が埋まっていなければ何もしない。
 * 3. window 全体の LCP が `minStableChars` 未満なら「まだ判断材料なし」として何もしない
 *    （history だけ更新する）。
 * 4. LCP が既存の `confirmedText` と異なれば、それを新しい `confirmedText` とする
 *    （伸びる場合も、稀な訂正で短く/別物になる場合も同じ扱い）。
 * 5. `confirmedText` が `lastEmittedText` と異なり、かつ debounce（`minEmitIntervalMs`）が
 *    経過していれば emit する。経過していなければ `confirmedText` は更新済みのまま次回以降に
 *    積み残しとして flush される。
 */
export function ingestRawPartial(
  state: SttStabilizerState,
  rawText: string,
  tMs: number,
  config: SttStabilizerConfig = DEFAULT_STT_STABILIZER_CONFIG,
): SttStabilizerResult {
  const history = [...state.history, rawText].slice(-config.stabilityWindow);
  let confirmedText = state.confirmedText;

  if (history.length >= config.stabilityWindow) {
    const prefix = longestCommonPrefix(history);
    if (prefix.length >= config.minStableChars && prefix !== confirmedText) {
      confirmedText = prefix;
    }
  }

  const withHistory: SttStabilizerState = { ...state, history, confirmedText };

  if (confirmedText === state.lastEmittedText) {
    return { state: withHistory, stable: null };
  }

  const debounceElapsed = state.lastEmitAtMs === null || tMs - state.lastEmitAtMs >= config.minEmitIntervalMs;
  if (!debounceElapsed) {
    return { state: withHistory, stable: null };
  }

  const nextState: SttStabilizerState = {
    ...withHistory,
    lastEmittedText: confirmedText,
    lastEmitAtMs: tMs,
  };
  return { state: nextState, stable: confirmedText };
}
