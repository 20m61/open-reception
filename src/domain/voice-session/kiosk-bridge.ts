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
import { normalize } from '@/domain/staff/search';
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
  const absent =
    input.unavailableDirectory === undefined ? null : resolveEntities(input.unavailableDirectory, input.text);

  /*
   * 🔴 不在の担当者も「近い候補」の比較相手に入れる (#1284)。
   *
   * 在席の辞書だけで曖昧さを判定すると、不在の人が比較相手から消え、同じ姓の在席者が
   * 単独の高信頼候補として**復唱なしで自動確定**していた（来訪者が呼びたい人と別人を呼ぶ）。
   * 選択肢として渡すのは引き続き在席者だけで、不在の人は判定の比較相手として見るだけ。
   *
   * 不在の人の方がはっきり一致するなら、在席の別人は選ばず、不在の名指しとして扱う。
   * 同点は不在側へ倒さない（在席者を呼びたい来訪者に「不在です」と言わない）。下の合算で
   * 曖昧と判定され、復唱確認へ回る。
   */
  const absentTop1 = absent?.top1 ?? null;
  if (absentTop1 !== null && absentTop1.entityConfidence > (resolution.top1?.entityConfidence ?? 0)) {
    return unavailableResult(input, thresholds, absentTop1, mergeTop3(absent?.top3 ?? [], resolution.top3));
  }

  const confirmation = decideEntityConfirmation(
    input.sttConfidence,
    mergeTop3(resolution.top3, absent?.top3 ?? []),
    thresholds,
    input.t,
  );

  if (confirmation === null && !hasSurnamePeer(input, resolution.top1)) {
    // 高信頼で、同じ姓の別人もいない → 自動採用（復唱なし）。top1 を選択対象として持ち回す。
    return { event: { type: 'heardAccepted' }, resolved: resolution.top1 };
  }

  if (resolution.top1 === null) {
    // 在席にも不在にも当たらなかった（不在だけに当たった場合は上で不在の名指しとして返している。
    // #803: 不在を見ずに聞き直すと、来訪者は同じ名前を言い直し続ける）。復唱できる対象が無いので聞き直し。
    return { event: { type: 'listenStart' }, resolved: null };
  }

  return {
    event: {
      type: 'heardNeedsConfirmation',
      displayName: resolution.top1.displayName,
      // 確信度では自動採用できたが、同じ姓の別人がいるので復唱する（owner の判断、#1284）。
      reason: confirmation?.reason ?? 'ambiguous_candidates',
      // 復唱テンプレートの出し分け (issue #361 申し送り)。resolveEntities は staff/department
      // 以外を返さないが、型上は EntityCandidateKind が広いため department 以外は 'staff' へ
      // 正規化する（安全側デフォルト = 従来の担当者向けテンプレート）。
      kind: resolution.top1.kind === 'department' ? 'department' : 'staff',
    },
    resolved: resolution.top1,
  };
}

/**
 * 不在の担当者を名指しされたときの結果 (#803)。
 *
 * 🔴 **低信頼で「不在です」と断定しない。** 聞き違えた名前に対して「◯◯は本日不在です」と
 * 言うのは、このプロジェクトが繰り返し塞いできた「果たせないことを言う」の裏返し —— **事実で
 * ないことを言う**形になる。断定は高信頼のときだけで、低信頼なら既存の復唱を挟んで来訪者に
 * 確かめてもらう（`unavailable: true` を載せ、確定しても選択へは進ませない）。
 * 確信の判定には、在席の候補も比較相手として含めた top3 を使う（#1284: 在席の近い名前を
 * 不在と断定しない）。
 *
 * 🔴 **どちらの場合も `resolved` は null。** タッチが押させない相手を音声が呼べてはいけない。
 */
function unavailableResult(
  input: BridgeCommittedTurnInput,
  thresholds: EntityResolutionThresholds,
  top1: EntityCandidate,
  top3: readonly EntityCandidate[],
): BridgeCommittedTurnResult {
  const confirmation = decideEntityConfirmation(input.sttConfidence, top3, thresholds, input.t);

  if (confirmation === null && !hasSurnamePeer(input, top1)) {
    return {
      event: { type: 'heardUnavailable', displayName: top1.displayName },
      resolved: null,
    };
  }

  return {
    event: {
      type: 'heardNeedsConfirmation',
      displayName: top1.displayName,
      reason: confirmation?.reason ?? 'ambiguous_candidates',
      kind: top1.kind === 'department' ? 'department' : 'staff',
      unavailable: true,
    },
    resolved: null,
  };
}

/**
 * 2 つの候補列を確信度の降順で合わせ、上位 3 件を返す。同点では先に渡した列の候補を前に置く
 * （`Array.prototype.sort` は安定）。
 */
function mergeTop3(
  first: readonly EntityCandidate[],
  second: readonly EntityCandidate[],
): EntityCandidate[] {
  return [...first, ...second].sort((a, b) => b.entityConfidence - a.entityConfidence).slice(0, 3);
}

/**
 * 同じ姓の別人が、在席・不在のどちらかの辞書にいるか（owner の判断、2026-10-28 / #1284）。
 *
 * 🔴 **同じ姓の人が 2 人以上いるときは、完全一致の人が 1 人だけでも自動で確定しない。**
 * 来訪者が姓だけで呼ぶ／聞き違える余地があるので、必ず復唱して確かめる。表示名が姓だけの人
 * （「田中」）がいる場合も同じ。確信度の差（完全一致 1.0 と前方一致 0.8）では区別しない。
 *
 * 担当者だけを見る（部署は姓を持たない）。判定は `sharesSurname`。
 */
function hasSurnamePeer(input: BridgeCommittedTurnInput, candidate: EntityCandidate | null): boolean {
  if (candidate === null || candidate.kind === 'department') return false;
  // 解決は enabled の担当者だけを対象にする（`resolveStaffEntities`）。比較の相手も同じにそろえる。
  const staff = [...input.directory.staff, ...(input.unavailableDirectory?.staff ?? [])].filter((s) => s.enabled);
  const self = staff.find((s) => s.id === candidate.id) ?? { displayName: candidate.displayName };
  return staff.some((s) => s.id !== candidate.id && sharesSurname(self, s));
}

/** 姓の判定に使う、担当者の名前の最小形。 */
export type NameForSurname = { readonly displayName: string; readonly kana?: string };

/**
 * 2 人の担当者が同じ姓とみなせるか。
 *
 * 担当者の辞書は姓と名を別の欄で持たないので、表示名と読み（kana）から推定する。どちらか一方で
 * 同じ姓とみなせれば真。比較の前に、検索と同じ正規化（NFKC・小文字・カタカナ→ひらがな）をかける。
 *
 * 1 つの表記（表示名どうし、または読みどうし）の中では、次の順で判定する。
 *  - 両方が空白（全角を含む）で区切られていれば、先頭の語どうしを比べる（「田中 花子」と「田中島 太郎」は別の姓）
 *  - 片方だけが区切られていれば、その先頭の語を姓とし、もう片方（空白を除く）がそれで始まるかを見る。
 *    **1 文字の姓も許す**（「林 太郎」と「林花子」）
 *  - どちらも区切られていなければ、片方がもう片方で始まる（姓だけの表示名。「森」と「森花子」）か、
 *    先頭 2 文字以上が一致するとき（「田中花子」と「田中太郎」）に同じ姓とみなす
 *
 * 表示名だけでは決められない 1 文字の姓（「林太郎」と「林花子」）は、読み（「はやしたろう」と
 * 「はやしはなこ」）で拾う。読みも区切りも無い 1 文字の姓は拾えない（`docs/adr/0011` 3-f）。
 * 推定は復唱が増える側に倒れることがある（「佐藤」と「里見」は読みが「さと」で始まる）が、
 * それは自動確定を減らすだけで、誤接続は増やさない。
 */
export function sharesSurname(a: NameForSurname, b: NameForSurname): boolean {
  if (sharesSurnameIn(a.displayName, b.displayName)) return true;
  return a.kana !== undefined && b.kana !== undefined && sharesSurnameIn(a.kana, b.kana);
}

function sharesSurnameIn(a: string, b: string): boolean {
  const tokens = (name: string) => normalize(name).split(/[\s\u3000]+/).filter((t) => t !== '');
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.length >= 2 && tb.length >= 2) return ta[0] === tb[0];
  const fa = ta.join('');
  const fb = tb.join('');
  if (ta.length >= 2) return fb.startsWith(ta[0] ?? '');
  if (tb.length >= 2) return fa.startsWith(tb[0] ?? '');
  if (fa.startsWith(fb) || fb.startsWith(fa)) return true;
  let common = 0;
  while (common < fa.length && common < fb.length && fa[common] === fb[common]) common += 1;
  return common >= 2;
}
