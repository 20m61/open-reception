/**
 * タッチファースト受付導線の逃げ道の純ロジック (issue #121 / Epic #119)。
 *
 * 方針:
 *   - 副作用なし（I/O・DOM・React 非依存）。node 環境でユニットテストできる。
 *   - ボタン集合・操作可否の唯一の真実源は #120 の UX 契約。本モジュールは表示のための
 *     label/variant/testId を付けるだけで、独自に状態遷移を進めない。
 *   - PII を一切扱わない。
 *
 * **待機の入口カード（クイックアクション）はここから契約へ移った** (#422 inc5-b 増分 3b)。
 * 集合・並び順・用件の先取り（presetPurpose）・QR 受付への引き渡し（handoff）は
 * `domain/reception/ui-contract.ts` が持ち、表示解決は `conversation-turn.ts` が担う。
 * ここに残るのは、アイコン写像（`quick-action-icons.ts`）が使う入口の語彙だけ。
 */
import {
  checkinEscapeHatchesFor,
  escapeHatchActionsFor,
  type ReceptionAction,
} from '@/domain/reception/ui-contract';
import type { ReceptionState } from '@/domain/reception/state';
import type { CheckinEvent, CheckinState } from '@/domain/checkin/state';
import type { MessageKey } from '@/lib/i18n';

/**
 * 待機画面の入口の語彙。**アイコン写像のためだけに残している**（#422 inc5-b 増分 3b で
 * 集合の定義そのものは契約へ移した）。
 *
 * 入口の意味は契約側に在る:
 *  - callStaff / department / delivery / other … `conversationTurnFor('idle').answers`
 *    （いずれも `intent: 'start'`。用件の先取りは `presetPurpose`）
 *  - checkin … `conversationTurnFor('idle').handoffs`（状態機械を進めず別シェルへ）
 */
export const QUICK_ACTION_INTENTS = [
  'callStaff',
  'checkin',
  'department',
  'delivery',
  'other',
] as const;

export type QuickActionIntent = (typeof QUICK_ACTION_INTENTS)[number];

/**
 * 常時見える「逃げ道」アクション。状態に応じて表示する (受け入れ条件)。
 *
 * 後退系コントロールは `back`（戻る=1 ステップ）/ `reset`（最初に戻る=リセット）の 2 語に集約する
 * (#325)。契約の `availableActions(state)` に含まれるものだけ出すため「許可されていない逃げ道は
 * 出さない」＝状態と矛盾しない。`reset` は契約上どの状態からも許可されるが、待機/初期画面（idle）
 * では戻る先が無く冗長なので出さない。
 *
 * #325 で削除した語彙:
 *  - `cancel`（キャンセル）: 来訪者は 戻る/キャンセル/最初に戻る の違いを判別しにくい。キャンセルは
 *    リセット相当（フローを破棄して待機へ）なので「最初に戻る」(reset) へ統合する。状態機械の
 *    CANCEL 遷移（ui-contract）自体は変更せず、逃げ道バーに別ボタンとして出さないだけ（表示位置の整理）。
 *  - `useFallback`（人に繋ぐ/代替連絡先）: これは受付を前進させる主 CTA（timeout/failed →
 *    fallback）であり後退系ではない。結果画面のコンテンツ側（ResultView の主 CTA）に置き、
 *    バーには出さない（同一機能ボタンの二重表示を解消）。
 */
const ESCAPE_HATCH_ACTIONS = ['back', 'reset'] as const;

type EscapeHatchAction = (typeof ESCAPE_HATCH_ACTIONS)[number];

export type EscapeHatch = {
  action: ReceptionAction;
  /**
   * 表示文言の i18n キー（**訳文そのものは持たない**）。
   *
   * 逃げ道バーは全画面に常設される唯一の後退導線 (#325) なので、ここが日本語固定だと
   * 言語を選んだ来訪者が受付中ずっと日本語のボタンを見続けることになる (#327)。
   * このモジュールは純ロジック（locale を知らない）なので、解決は描画側が行う。
   */
  labelKey: MessageKey;
  /** 強調度。後退系（戻る/最初に戻る）はいずれも控えめ(ghost)。 */
  variant: 'ghost' | 'secondary';
  testId: string;
};

const ESCAPE_HATCH_META: Record<EscapeHatchAction, Omit<EscapeHatch, 'action'>> = {
  back: { labelKey: 'reception.back', variant: 'ghost', testId: 'escape-back' },
  reset: { labelKey: 'reception.reset', variant: 'ghost', testId: 'escape-reset' },
};

/**
 * 逃げ道バーに出すアクションと、その表示メタを返す。
 *
 * **どのアクションを出すかは契約（`escapeHatchActionsFor`）が唯一の権威**で、ここは
 * label/variant/testId を付けるだけ (#422 地ならし)。かつて判断が両方に二重実装され、
 * `confirming` の back 抑制（#240/#325）が契約側に無いという食い違いがあった。片方を
 * 直してももう片方に伝播しないため、判断は domain へ寄せた。
 *
 * 一致は `quick-actions.test.ts` のメタテストで固定している。
 */
export function escapeHatchesFor(state: ReceptionState): ReadonlyArray<EscapeHatch> {
  return escapeHatchActionsFor(state).map(({ action }) => ({
    action,
    ...ESCAPE_HATCH_META[action as EscapeHatchAction],
  }));
}

/**
 * QR 受付の逃げ道の表示メタ (#361 AC2)。受付側（`EscapeHatch`）と同じ形。
 *
 * `event` を持つのは、QR 受付の進行が `ReceptionAction` ではなく `CheckinEvent` で動くため
 * （表示は共通でも状態機械は別。写像を挟んで嘘の action を作らない）。
 */
export type CheckinEscape = {
  event: CheckinEvent;
  /** 表示文言の i18n キー。**受付の逃げ道と同じキーを使う**（QR だけ別の言葉にしない）。 */
  labelKey: MessageKey;
  variant: 'ghost' | 'secondary';
  testId: string;
};

/**
 * 逃げ道イベント → 表示メタ。
 *
 * 受付の `ESCAPE_HATCH_META.reset` と**同じ labelKey / variant / testId** を使う。来訪者が
 * 受付で覚えた「最初に戻る」を QR でもそのまま探せるようにするため（#361 AC2）。一致は
 * `quick-actions.test.ts` が固定する。
 */
const CHECKIN_ESCAPE_META: Partial<Record<CheckinEvent, Omit<CheckinEscape, 'event'>>> = {
  RESET: ESCAPE_HATCH_META.reset,
};

/**
 * QR 受付の逃げ道バーに出すイベントと、その表示メタを返す。
 *
 * **どのイベントを出すかは契約（`checkinEscapeHatchesFor`）が唯一の権威**で、ここは
 * label/variant/testId を付けるだけ（受付側 `escapeHatchesFor` と同じ役割分担）。
 * 表示メタを持たないイベントは出さない（契約に足しただけで黙って描かれるのを防ぐ）。
 */
export function checkinEscapesFor(state: CheckinState): ReadonlyArray<CheckinEscape> {
  const escapes: CheckinEscape[] = [];
  for (const { event } of checkinEscapeHatchesFor(state)) {
    const meta = CHECKIN_ESCAPE_META[event];
    if (meta === undefined) continue;
    escapes.push({ event, ...meta });
  }
  return escapes;
}
