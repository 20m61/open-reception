/**
 * #370 (STT) との整合 (issue #372 実装タスク「STT final/turn 終了と #370 の stabilizer/final
 * イベントとの整合(turn 終了で STT close せず、次発話を受けられる)」)。
 *
 * `src/domain/voice-stt/types.ts` の `SttSession` は `close()` を持つが、**ターン確定はこれを
 * 呼ばない**。ターン確定が意味するのは「このターンの partial 蓄積をリセットして次発話に備える」
 * ことだけであり、「マイク入力を止める/ストリームを閉じる」こととは別責務——受付シナリオは
 * 複数ターンの対話が続くため、ターンごとに接続を張り直すのは無駄なレイテンシとコストになる。
 * `close()` を呼んでよいのは、セッション終了（離脱・タイムアウト）等 `#370`/呼び出し側が
 * 明示的に判断する場面だけであり、それはこのモジュールの外側の責務のまま残す。
 *
 * ここでは「ターン確定時に何をリセットし、何をリセットしないか」を型で明示することで、
 * 実装側（`src/lib/voice-turn/`, 次周回）が誤って `session.close()` を呼ばずに済むようにする。
 */
import { emptyStabilizerState, type SttStabilizerState } from '@/domain/voice-stt/stabilizer';
import type { SttSession } from '@/domain/voice-stt/types';

/**
 * ターン確定時に STT 側で行うべきことの型。`closeSession` を意図的に**持たない** ——
 * 呼べるものを型に出さないことで、「turn.committed で close する」誤配線を型レベルで防ぐ。
 */
export type SttTurnCommitEffects = {
  /** 次ターンの partial 蓄積を空から始めるための初期状態。 */
  nextStabilizerState: SttStabilizerState;
};

/**
 * ターン確定時に呼ぶ。`SttSession`（`close()` を持つ interface）を受け取らないことが
 * シグネチャ自体で「close しない」を表す。
 */
export function onTurnCommitted(): SttTurnCommitEffects {
  return { nextStabilizerState: emptyStabilizerState() };
}

/**
 * 型レベルの回帰防止用ヘルパー: `SttSession` から `close` を除いた型。ターン確定の配線コードが
 * この型だけを受け取るようにしておけば、`close()` を誤って呼べなくなる
 * （呼び出し側でセッション終了時のみ元の `SttSession` を扱う）。
 */
export type SttSessionWithoutClose = Omit<SttSession, 'close'>;
