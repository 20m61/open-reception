/**
 * 受付端末 統合ロジック (issue #96 / #79 / #100 / #101 / #102, kiosk-integration inc1)。
 *
 * スタンドアロンで作った待機サイネージ・カスタム受付フロー・来訪者検知・退館導線を、
 * 中核 KioskFlow へ**フォールバック付きで**配線するための純関数を集約する。
 *
 * 方針:
 *   - すべて副作用なし（I/O・DOM・React 非依存）。node 環境でユニットテストできる。
 *   - 「設定が無い / 取得失敗」時は必ず現行（既定）挙動へ倒す（非破壊）。判断はここに閉じ、
 *     KioskFlow 側は結果に従って分岐するだけにする。
 */
import type { KioskFlow, FlowFieldValues } from './custom-flow/types';
import {
  isReceptionPurposeId,
  type ReceptionPurposeId,
  type VisitorInfo,
} from '@/domain/reception/session';

/**
 * カスタムフローの purposeKey を既存 ReceptionPurposeId へ写す (issue #100 統合)。
 *
 * 受付セッション作成 API（/api/kiosk/receptions）は purpose を ReceptionPurposeId に限定して
 * 検証する。カスタムフローの purposeKey は自由文字列のため、既知のキーは対応する purpose へ、
 * 未知のキーは 'other' へ倒す（受付を止めない・非破壊）。purposeKey 自体は呼び出し payload の
 * purposeKey として別途送り、サーバ側の将来拡張に備える。
 */
const PURPOSE_KEY_MAP: Record<string, ReceptionPurposeId> = {
  meeting: 'meeting',
  delivery: 'delivery',
  interview: 'interview',
  other: 'other',
};

export function purposeIdForFlow(flow: Pick<KioskFlow, 'purposeKey'>): ReceptionPurposeId {
  const key = flow.purposeKey.trim().toLowerCase();
  if (PURPOSE_KEY_MAP[key]) return PURPOSE_KEY_MAP[key];
  if (isReceptionPurposeId(key)) return key;
  return 'other';
}

/* ===================== カスタムフロー適用判定 ===================== */

/**
 * カスタムフローを適用すべきか。
 * 取得前(null)・取得失敗(null)・空配列のときは false（既定の通常受付へフォールバック）。
 */
export function shouldUseCustomFlow(flows: readonly KioskFlow[] | null | undefined): boolean {
  return Array.isArray(flows) && flows.length > 0;
}

/**
 * カスタムフローの入力値（key→値）を、既存状態機械が扱う VisitorInfo へ写す。
 *
 * 既存 VisitorInfo は name / company / note のみを持つため、フィールド key の慣習名
 * （name / company / note）を優先して拾う。該当キーが無い場合でも受付を止めないため、
 * 残りの入力は「ラベル: 値」を連結して note へ畳み込み、確認画面・呼び出しに渡す。
 * checkbox は「同意/該当」を表すため true のもののみラベルを残す。
 *
 * @param flow   選択されたカスタムフロー（fields のラベル参照に使う）。
 * @param values 来訪者が入力した値。
 */
export function flowValuesToVisitorInfo(flow: KioskFlow, values: FlowFieldValues): VisitorInfo {
  const labelOf = (key: string) => flow.fields.find((f) => f.key === key)?.label ?? key;
  const asText = (key: string): string => {
    const v = values[key];
    return typeof v === 'string' ? v.trim() : '';
  };

  const name = asText('name');
  const company = asText('company');
  const explicitNote = asText('note');

  // name/company/note 以外のフィールドを「ラベル: 値」で note へ畳み込む（受付を止めない）。
  const RESERVED = new Set(['name', 'company', 'note']);
  const extras: string[] = [];
  for (const field of flow.fields) {
    if (RESERVED.has(field.key)) continue;
    const raw = values[field.key];
    if (field.type === 'checkbox') {
      if (raw === true) extras.push(labelOf(field.key));
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text !== '') extras.push(`${labelOf(field.key)}: ${text}`);
  }

  const noteParts = [explicitNote, ...extras].filter((p) => p !== '');
  const note = noteParts.length > 0 ? noteParts.join(' / ') : undefined;

  // name が未入力でも呼び出し自体は可能にする（既定フローと同様に name は任意扱い）。
  return {
    name,
    company: company !== '' ? company : undefined,
    note,
  };
}

/* ===================== サイネージ待機ゲート判定 ===================== */

/**
 * 待機（idle）中にサイネージを待機画面として重ねるべきか。
 *
 * 条件（すべて満たすときのみ true）:
 *   - 受付状態が idle（受付進行中・結果表示中は出さない）。
 *   - 端末がオンライン（通信断時は既存のオフライン表示を優先）。
 *   - 端末が失効していない（active===false は既存の利用不可表示を優先）。
 *   - 再生可能なサイネージ項目がある。
 *
 * いずれか欠ければ false ＝ 既存の IdleView をそのまま使う（非破壊フォールバック）。
 */
export function shouldShowSignage(input: {
  receptionState: string;
  online: boolean;
  active: boolean | null;
  signageItemCount: number;
}): boolean {
  if (input.receptionState !== 'idle') return false;
  if (!input.online) return false;
  if (input.active === false) return false;
  return input.signageItemCount > 0;
}

/* ===================== /kiosk アクセスゲート判定 ===================== */

export type KioskGate = 'revoked' | 'authorize' | 'unenrolled' | 'checking' | 'ready';

/**
 * `/kiosk` のアクセスゲートを判定する (issue #239)。受付端末は kiosk セッション
 * （管理発行 URL/QR からのエンロール、または PIN 許可 #23）必須にし、未保持なら受付フローを
 * 出さず誘導する。これにより `/kiosk` への直接到達で誰でも受付フローを開ける穴を塞ぐ。
 *
 * **fail-closed**: セッションの有無が未確定（`authorized===null`）の間は受付フローを出さない。
 * 実アクセス制御はサーバ側ガード（`denyWithoutKioskSession`）が担い、本判定は UX 誘導。
 *
 *   - `active===false`（失効/緊急停止）→ `'revoked'`（最優先・既存の利用不可表示）。
 *   - `authorized===null`（heartbeat 未確定・取得失敗）→ `'checking'`。受付フローを出さず確認中表示。
 *     heartbeat 成功で確定するまで開かない（取得失敗が続いても開かない）。確立済み端末は前回成功時の
 *     `authorized===true` を保持するため `'ready'` のまま（ネットワーク断は別途オフライン表示）。
 *   - セッション未保持（`authorized===false`）:
 *       - PIN 必須なら `'authorize'`（PIN で自己許可できる, #23）。
 *       - PIN 不要なら `'unenrolled'`（自己許可手段が無い → 管理発行の受付URL/QRでエンロール）。
 */
export function resolveKioskGate(input: {
  active: boolean | null;
  authorized: boolean | null;
  pinRequired: boolean;
}): KioskGate {
  if (input.active === false) return 'revoked';
  if (input.authorized === null) return 'checking';
  if (input.authorized === false) return input.pinRequired ? 'authorize' : 'unenrolled';
  return 'ready';
}
