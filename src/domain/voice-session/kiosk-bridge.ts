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
  /**
   * **不在の担当者**の辞書 (#803)。選択させないが、名指しされたことは認識する。
   *
   * 省略可 —— 渡さなければ従来どおり「候補ゼロ → 聞き直し」になる（既存呼び出し元は無変更）。
   */
  unavailableDirectory?: EntityDirectory;
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
    /*
     * 在席者に当たらなかった。**不在の相手を名指しされていないか**を見てから聞き直す (#803)。
     *
     * これを見ないと、タッチが「本日不在です」と理由を言う場面で音声だけが黙り、
     * 来訪者には「聞き取れなかった」に見えて**同じ名前を言い直し続ける**。
     */
    const unavailable = matchUnavailable(input, thresholds);
    if (unavailable !== null) return unavailable;

    // 候補ゼロ → 復唱できる対象が無いので聞き直し。
    return { event: { type: 'listenStart' }, resolved: null };
  }

  return {
    event: {
      type: 'heardNeedsConfirmation',
      displayName: resolution.top1.displayName,
      reason: confirmation.reason,
      // 復唱テンプレートの出し分け (issue #361 申し送り)。resolveEntities は staff/department
      // 以外を返さないが、型上は EntityCandidateKind が広いため department 以外は 'staff' へ
      // 正規化する（安全側デフォルト = 従来の担当者向けテンプレート）。
      kind: resolution.top1.kind === 'department' ? 'department' : 'staff',
    },
    resolved: resolution.top1,
  };
}

/**
 * 不在の担当者に当たったか。当たっていなければ `null`（呼び出し側は従来どおり聞き直す）。
 *
 * 🔴 **低信頼で「不在です」と断定しない。** 聞き違えた名前に対して「◯◯は本日不在です」と
 * 言うのは、このプロジェクトが繰り返し塞いできた「果たせないことを言う」の裏返し —— **事実で
 * ないことを言う**形になる。断定は高信頼のときだけで、低信頼なら既存の復唱を挟んで来訪者に
 * 確かめてもらう（`unavailable: true` を載せ、確定しても選択へは進ませない）。
 *
 * 🔴 **どちらの場合も `resolved` は null。** タッチが押させない相手を音声が呼べてはいけない。
 */
function matchUnavailable(
  input: BridgeCommittedTurnInput,
  thresholds: EntityResolutionThresholds,
): BridgeCommittedTurnResult | null {
  if (input.unavailableDirectory === undefined) return null;

  const resolution = resolveEntities(input.unavailableDirectory, input.text);
  if (resolution.top1 === null) return null;

  const confirmation = decideEntityConfirmation(
    input.sttConfidence,
    resolution.top3,
    thresholds,
    input.t,
  );

  if (confirmation === null) {
    return {
      event: { type: 'heardUnavailable', displayName: resolution.top1.displayName },
      resolved: null,
    };
  }

  return {
    event: {
      type: 'heardNeedsConfirmation',
      displayName: resolution.top1.displayName,
      reason: confirmation.reason,
      kind: resolution.top1.kind === 'department' ? 'department' : 'staff',
      unavailable: true,
    },
    resolved: null,
  };
}
