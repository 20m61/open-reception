/**
 * タッチファースト受付導線のクイックアクション/逃げ道の純ロジック (issue #121 / Epic #119)。
 *
 * 方針:
 *   - 副作用なし（I/O・DOM・React 非依存）。node 環境でユニットテストできる。
 *   - ボタン集合・操作可否の唯一の真実源は #120 の UX 契約（`availableActions(state)` /
 *     `isActionAllowed`）。本モジュールは「画面に出すクイックアクション/逃げ道」を、
 *     契約が許可する範囲に**制約**して導出するだけで、独自に状態遷移を進めない。
 *   - 重要操作（呼び出し確定・個人情報確定）はクイックアクションに含めない（必ず確認画面を
 *     踏む。確認必須の不変条件は ui-contract が担保する）。
 *   - PII を一切扱わない。
 */
import {
  availableActions,
  isActionAllowed,
  type ReceptionAction,
} from '@/domain/reception/ui-contract';
import type { ReceptionState } from '@/domain/reception/state';
import type { ReceptionPurposeId } from '@/domain/reception/session';
import type { MessageKey } from '@/lib/i18n';

/**
 * 待機画面に大きなカードで提示する主要 CTA（来訪者の入口）。
 *
 * いずれも `start`（待機→目的選択）から始まる導線だが、来訪者の用件を先に汲み取ることで
 * 「1 タップで主要受付パターンへ進める」（受け入れ条件）を満たす。`presetPurpose` を持つ
 * CTA は目的選択を省略して担当/部署選択へ素早く進められるよう、UI 側のヒントにする。
 *  - callStaff: 担当者を呼ぶ（用件は後段の目的選択で確定。preset を置かず汎用導線にする）
 *  - checkin:   QR で受付（受付モードを checkin へ切替える特別 CTA）
 *  - department:部署から選ぶ（目的: 面会相当を preset し、担当/部署選択へ）
 *  - delivery:  配送・納品（目的: 納品を preset）
 *  - other:     その他のご用件（目的: その他を preset）
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
 * **表示文言は持たない。** カードのラベル・説明は描画側が `intent` から i18n キーへ写す
 * （`reception-screens.tsx` の `QUICK_ACTION_I18N`）。以前は使われない日本語の
 * `label` / `description` を持っており、`action.label` を描画すると多言語が崩れる罠に
 * なっていたため、型ごと落とした (#327)。
 */
export type QuickAction = {
  intent: QuickActionIntent;
  /**
   * この CTA が選んだあとに引き継ぐ目的（あれば）。
   * checkin は受付モード切替のため purpose を持たない。callStaff は用件未確定で目的選択へ。
   */
  presetPurpose?: ReceptionPurposeId;
  /**
   * QR 受付モードへ切替える特別 CTA か（通常の START 導線ではない）。
   * true のとき UI はモード切替（CheckinFlow）を行い、状態機械の START は使わない。
   */
  isCheckin?: boolean;
  testId: string;
};

/**
 * 待機画面のクイックアクション定義（表示順）。
 * 「担当者を呼ぶ」を先頭の主目的に置き、QR・部署・配送・その他を続ける。
 */
const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  {
    intent: 'callStaff',
    testId: 'quick-call-staff',
  },
  {
    intent: 'checkin',
    isCheckin: true,
    testId: 'quick-checkin',
  },
  {
    intent: 'department',
    presetPurpose: 'meeting',
    testId: 'quick-department',
  },
  {
    intent: 'delivery',
    presetPurpose: 'delivery',
    testId: 'quick-delivery',
  },
  {
    intent: 'other',
    presetPurpose: 'other',
    testId: 'quick-other',
  },
];

/**
 * 待機画面に出すクイックアクション集合を返す。
 *
 * 通常受付の入口（callStaff/department/delivery/other）は契約上 `start` が許可されている
 * idle のときだけ出す。QR 受付（checkin）はモード切替であり状態機械の遷移ではないため、
 * idle なら常に併記する。これにより「初期画面から主要受付パターンへ 1 タップ」を満たしつつ、
 * 許可されていない状態ではクイックアクションを出さない（契約に従う）。
 */
export function quickActionsFor(state: ReceptionState): ReadonlyArray<QuickAction> {
  if (state !== 'idle') return [];
  const canStart = isActionAllowed(state, 'start');
  return QUICK_ACTIONS.filter((a) => (a.isCheckin ? true : canStart));
}

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
 * 逃げ道バーに `back`（戻る）を重複表示しない状態 (#240 / #325)。確認画面（confirming）は短い要約で、
 * フッターの「修正する」(confirm-back) が常に到達可能なため、常設バーの 戻る と二重になる後退系
 * コントロールを整理する。戻る操作自体はフッターの文脈ボタン（修正する）で可能なので機能は失わない。
 *
 * selectingTarget（担当者一覧）/ inputVisitorInfo（入力フォーム）は内容がビューポートを超え得るため
 * 除外しない。#325 でコンテンツ側の戻る（target-back/visitor-back）を撤去したため、sticky で常時可視な
 * バーの 戻る が唯一の戻る導線になる（ここで back を残さないと戻れなくなる）。
 */
const STATES_WITH_CONTEXTUAL_BACK: ReadonlySet<ReceptionState> = new Set(['confirming']);

export function escapeHatchesFor(state: ReceptionState): ReadonlyArray<EscapeHatch> {
  // idle では逃げ道を出さない（クイックアクションが入口で、戻る先が無い）。
  if (state === 'idle') return [];
  const allowed = availableActions(state);
  const omitBack = STATES_WITH_CONTEXTUAL_BACK.has(state);
  return ESCAPE_HATCH_ACTIONS.filter(
    (a) => allowed.has(a) && !(a === 'back' && omitBack),
  ).map((action) => ({
    action,
    ...ESCAPE_HATCH_META[action],
  }));
}
