/**
 * 音声で確定した Entity 候補 → 受付フローの「相手選択」への写像 (issue #364 kiosk 配線 / #361)。
 *
 * `VoiceSessionLayer` の `onResolved(candidate)`（復唱確認「はい」または高信頼自動採用で確定した
 * 担当者/部門候補）を、`KioskFlow` のタッチ経路と**同一の** `SELECT_TARGET` 相手（`ReceptionTarget`）
 * へ変換する純関数。KioskFlow はこの戻り値をそのまま `dispatch({ type: 'SELECT_TARGET', target })` に
 * 渡すため、音声経路とタッチ経路は完全に同じ reducer アクションへ収束する。
 *
 * タッチ／音声の競合規則（**後勝ち / last-write-wins**）:
 *   相手選択は音声・タッチのどちらからでも同一の `SELECT_TARGET` を dispatch する。特別な優先制御は
 *   持たず、**後に発火した選択が最終的な相手になる**（reducer の SELECT_TARGET は常に `target` を
 *   置き換える）。この規則を選ぶ理由は実装の単純さ: 二重の真実源や「確認中はタッチを無効化」といった
 *   排他ロックを持ち込まず、両経路を同じ 1 本のアクションに集約することで競合が構造的に発生しない
 *   （どちらが後でも壊れない）。復唱確認（readback）中もタッチ選択は生きており、来訪者がタッチで
 *   別の相手を選べば、その後に音声確定が来ない限りタッチが最終値になる。
 *
 * PII 方針: `candidate.displayName` は組織が管理する担当者/部門辞書由来の表示名で、来訪者本人の
 * 氏名等ではない（`.claude/rules/pii-secret-minimization.md`）。
 */
import type { ReceptionTargetType } from '@/domain/reception/session';
import type { EntityCandidate } from '@/domain/voice-stt/entity-resolver';

/** 受付フローが呼び出す相手（KioskFlow の `SELECT_TARGET` が要求する構造）。 */
export type ReceptionTarget = {
  type: ReceptionTargetType;
  id: string;
  label: string;
  /**
   * 表示専用の副題（担当者の所属など）。同姓同名を**発信直前に**確認するために出す (#591)。
   *
   * **`label` に混ぜないこと。** `label` は読み上げ（`KioskFlow` の TTS）と監査
   * （`domain/routing/compat.ts` の `targetLabel`）にも流れる。所属を混ぜると
   * 「営業部（兼: 技術部）の山田太郎さんをお呼びしています」のような不自然な読み上げになり、
   * 監査レコードにも表示都合の文字列が入る。表示だけに使う値はここへ置く。
   */
  sublabel?: string;
};

/** EntityCandidate.kind のうち、実際に呼び出せる相手種別（staff / department）へ絞る。 */
function toTargetType(kind: EntityCandidate['kind']): ReceptionTargetType | null {
  if (kind === 'staff') return 'staff';
  if (kind === 'department') return 'department';
  // purpose / other は「相手」ではない（用件・その他）。相手選択には使わない。
  return null;
}

/**
 * 音声確定候補を受付の相手選択へ写像する。
 *  - null（候補なし。復唱不能で聞き直したケース等）→ null（何も選択しない）。
 *  - kind が staff/department 以外（purpose/other）→ null（相手ではないので選択しない）。
 *  - それ以外 → タッチ経路の `onSelect` と同一構造の相手を返す。
 */
export function voiceCandidateToTarget(candidate: EntityCandidate | null): ReceptionTarget | null {
  if (candidate === null) return null;
  const type = toTargetType(candidate.kind);
  if (type === null) return null;
  return { type, id: candidate.id, label: candidate.displayName };
}
