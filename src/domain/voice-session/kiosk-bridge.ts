/**
 * 発話確定（turn 確定）→ 既存の選択肢マッチングへの橋渡し (issue #364 kiosk 配線)。
 *
 * orchestrator の `onTurnCommitted(text)` で届く確定テキストを、既存の #370 Entity 解決
 * （`resolveEntities` + `decideEntityConfirmation`）へ通し、Kiosk UI 状態機械（`kiosk-view.ts`）が
 * 消費する `VoiceKioskEvent` へ写像する **純関数**。UI 状態も I/O も持たない。
 *
 * 方針:
 *  - 低信頼（STT/Entity/曖昧）の判定は既存の `decideEntityConfirmation` をそのまま再利用する
 *    （#370 の閾値・優先順位を二重化しない）。低信頼なら復唱確認（readback）へ、高信頼なら自動採用。
 *  - 解決不能（候補ゼロ）のときは復唱で読み上げる対象が無いため、復唱を出さず聞き直し（listenStart）
 *    を返す（誤った「◯◯様ですね？」を出さない）。
 *  - 確定後に実際の選択（既存 UI の選択肢マッチング）へ渡せるよう、解決済み候補（top1）を併せて返す。
 *  - PII を持ち込まない: 返り値の `resolved`/`displayName` は組織が管理する担当者/部門辞書由来の値のみ。
 */
import {
  resolveEntities,
  decideEntityConfirmation,
  DEFAULT_ENTITY_RESOLUTION_THRESHOLDS,
  type EntityDirectory,
  type EntityCandidate,
  type EntityResolutionThresholds,
} from '@/domain/voice-stt/entity-resolver';
import type { VoiceKioskEvent } from './kiosk-view';

export type BridgeCommittedTurnInput = {
  /** orchestrator が確定した発話テキスト。 */
  text: string;
  /** マッチング対象の担当者/部門辞書（Kiosk が保持する directory）。 */
  directory: EntityDirectory;
  /** その発話の STT confidence（Entity confidence とは別軸、#370）。 */
  sttConfidence: number;
  /** 低信頼判定の閾値（省略時は #370 既定）。 */
  thresholds?: EntityResolutionThresholds;
  /** セッション開始からの相対 ms（#365 単一時計源）。 */
  t: number;
};

export type BridgeCommittedTurnResult = {
  /** Kiosk 状態機械へ dispatch すべきイベント。 */
  event: VoiceKioskEvent;
  /** 確定時に選択へ渡す解決済み候補（無ければ null）。 */
  resolved: EntityCandidate | null;
};

/**
 * 確定テキストを Entity 解決へ通し、Kiosk UI イベント + 解決済み候補へ写像する。
 */
export function bridgeCommittedTurn(input: BridgeCommittedTurnInput): BridgeCommittedTurnResult {
  const thresholds = input.thresholds ?? DEFAULT_ENTITY_RESOLUTION_THRESHOLDS;
  const resolution = resolveEntities(input.directory, input.text);
  const confirmation = decideEntityConfirmation(input.sttConfidence, resolution.top3, thresholds, input.t);

  if (confirmation === null) {
    // 高信頼 → 自動採用（復唱なし）。top1 を選択対象として持ち回す。
    return { event: { type: 'heardAccepted' }, resolved: resolution.top1 };
  }

  if (resolution.top1 === null) {
    // 候補ゼロ → 復唱できる対象が無いので聞き直し。
    return { event: { type: 'listenStart' }, resolved: null };
  }

  return {
    event: {
      type: 'heardNeedsConfirmation',
      displayName: resolution.top1.displayName,
      reason: confirmation.reason,
    },
    resolved: resolution.top1,
  };
}
